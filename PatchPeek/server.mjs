import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const port = 3000;
const configFile = path.resolve("./data/config.json");
let lastUpdateTime = 0;
let rateLimitHit = false;

const defaultConfig = { feeds: [], daysWindow: 31, githubToken: "" };
const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];
const cache = {}; // { [repo]: { etag, releases } }

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

const readConfig = async () => {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  try {
    return JSON.parse(await fs.readFile(configFile, "utf-8"));
  } catch {
    await fs.writeFile(configFile, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
};

const saveConfig = async (config) =>
  fs.writeFile(configFile, JSON.stringify(config, null, 2));

const updateConfigField = async (field, value) => {
  if (typeof field !== "string") return;
  const config = await readConfig();
  config[field] = value;
  await saveConfig(config);
};

const hasWarning = (text) =>
  keywords.some((kw) => text?.toLowerCase().includes(kw));

const isValidRelease = (release, cutoff) =>
  !release.draft &&
  !release.prerelease &&
  new Date(release.published_at).getTime() >= cutoff;

const filterRecentReleases = (releases, cutoff) =>
  releases.filter((release) => isValidRelease(release, cutoff));

const loadConfigAndCutoff = async () => {
  const config = await readConfig();
  return { ...config, cutoff: Date.now() - config.daysWindow * 86400000 };
};

// Fetch releases with HTML-rendered markdown from GitHub
const fetchReleases = async (repo, token, cutoff, force = false) => {
  const commonHeaders = {
    Accept: "application/vnd.github.v3.html+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!force && cache[repo]?.etag ? { "If-None-Match": cache[repo].etag } : {}),
  };

  let allReleases = [];
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    console.log(`[GitHub Releases] Fetching ${repo} page ${page}`);
    const url = `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`;
    const res = await fetch(url, { headers: commonHeaders });

    if (res.status === 304) return cache[repo].releases;
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
      throw Object.assign(new Error("rateLimited"), { rateLimited: true });
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);

    const pageReleases = await res.json();
    if (!Array.isArray(pageReleases) || pageReleases.length === 0) break;

    allReleases.push(...pageReleases.map(r => ({
      id: r.id,
      name: r.name,
      tag_name: r.tag_name,
      published_at: r.published_at,
      body_html: r.body_html || "<i>No description</i>",
      flagged: hasWarning(r.body_html),
    })));

    // Check oldest date in this page
    const oldest = new Date(pageReleases[pageReleases.length - 1].published_at).getTime();
    if (oldest < cutoff) {
      console.log(`[GitHub Releases] Stopping ${repo} — oldest release older than cutoff`);
      break;
    }

    page++;
  }

  cache[repo] = {
    etag: cache[repo]?.etag,
    releases: allReleases,
  };

  return allReleases;
};


const repoExists = async (repo, token) => {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status === 200;
};

// Process one repo's feed
const processFeed = async (repo, cutoff, token, force = false) => {
  try {
    const releases = await fetchReleases(repo, token, cutoff, force);
    const recent = releases.filter((release) =>
      isValidRelease(release, cutoff)
    );

    return {
      project: repo,
      releases: recent.map((release) => ({
        title: release.name || release.tag_name,
        date: release.published_at.slice(0, 10),
        html: release.body_html,
        flagged: release.flagged
      })),
    };
  } catch (err) {
    if (err.rateLimited) {
      return {
        project: `Failed → ${repo}`,
        rateLimited: true,
      };
    }
    console.error(
      process.env.NODE_ENV === "development"
        ? err
        : `[Feed] Failed to process ${repo}: ${err.message}`
    );
    return { project: `Failed → ${repo}`, releases: [] };
  }
};

// Remove old/unused cache
const cleanCache = async (feeds, cutoff) => {
  for (const repo of Object.keys(cache)) {
    if (!feeds.includes(repo)) {
      console.log(`[Cache] Removing cached data for removed repo: ${repo}`);
      delete cache[repo];
    }
  }

  for (const repo of feeds) {
    if (!cache[repo]) continue;
    const recent =
      cache[repo].releases?.filter(
        (release) => new Date(release.published_at).getTime() >= cutoff
      ) || [];
    cache[repo].releases = recent;
  }
};

// Update all feeds
const updateAllFeeds = async (force = false) => {
  try {
    const { feeds, githubToken, cutoff } = await loadConfigAndCutoff();
    const results = await Promise.all(
      feeds.map((repo) => processFeed(repo, cutoff, githubToken, force))
    );
    rateLimitHit = results.some((release) => release.rateLimited);
    await cleanCache(feeds, cutoff);
  } catch (err) {
    console.error("[Background Fetch] Error:", err);
  } finally {
    lastUpdateTime = Date.now();
    console.log(" ");
  }
};

// Render homepage
const renderHomepage = async (res, errorMessage = null) => {
  const { feeds, daysWindow, githubToken, cutoff } =
    await loadConfigAndCutoff();
  const feedData = feeds.map((repo) => {
    const recent = filterRecentReleases(cache[repo]?.releases || [], cutoff);
    const display = recent
      .map((release) => ({
        title: release.name || release.tag_name,
        date: release.published_at.slice(0, 10),
        html: release.body_html,
        flagged: release.flagged
      }))
      .filter((release) => release.html);

    return {
      project: repo,
      releases: display,
      releaseCount: display.length,
      breakingCount: display.filter((release) => release.flagged).length,
    };
  });

  const feedsWithReleases = feedData
    .filter((f) => f.releaseCount > 0)
    .sort((a, b) =>
      b.breakingCount === a.breakingCount
        ? b.releaseCount - a.releaseCount
        : b.breakingCount - a.breakingCount
    );

  res.render("index", {
    rateLimitHit,
    isAuthenticated: !!githubToken,
    feedsList: feeds,
    feedsWithReleases,
    daysWindow,
    lastUpdateTime,
    now: Date.now(),
    errorMessage,
  });
};

// Routes
app.get("/", async (_, res) => {
  res.set("Cache-Control", "no-store");
  await renderHomepage(res);
});

app.post("/add-feed", async (req, res) => {
  const raw = req.body.feedSlug?.trim();
  const match = raw?.match(
    /^(?:https:\/\/github\.com\/)?([^/]+\/[^/]+?)(?:\.git|\/.*)?$/
  );
  const config = await readConfig();

  if (!raw) return await renderHomepage(res, "Repository is required");
  if (!match)
    return await renderHomepage(res, "Invalid GitHub repository format");
  const repo = match[1];
  if (config.feeds.includes(repo))
    return await renderHomepage(res, "Repository is already in your list");
  if (!(await repoExists(repo, config.githubToken)))
    return await renderHomepage(res, "GitHub repository not found");

  config.feeds.push(repo);
  await saveConfig(config);
  await updateAllFeeds();
  res.redirect("/");
});

app.post("/remove-feed", async (req, res) => {
  const config = await readConfig();
  const cutoff = Date.now() - config.daysWindow * 86400000;
  const repoSlugs = [].concat(req.body.feedSlug || []);
  config.feeds = config.feeds.filter((f) => !repoSlugs.includes(f));
  await saveConfig(config);
  await cleanCache(config.feeds, cutoff);
  res.redirect("/");
});

app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!isNaN(days) && days > 0) await updateConfigField("daysWindow", days);
  await updateAllFeeds(true);
  res.redirect("/");
});

app.post("/update-token", async (req, res) => {
  const token = req.body.githubToken?.trim() || "";
  const validFormat = !token || /^github_pat_|^ghp_/.test(token);
  if (!validFormat) {
    return renderHomepage(
      res,
      "Invalid GitHub token format. Please check your token."
    );
  }
  await updateConfigField("githubToken", token);
  await updateAllFeeds();
  res.redirect("/");
});

(async () => {
  await updateAllFeeds();
  setInterval(updateAllFeeds, 60 * 60 * 1000);
  app.listen(port, () =>
    console.log(`Server running at http://localhost:${port} \n`)
  );
})();
