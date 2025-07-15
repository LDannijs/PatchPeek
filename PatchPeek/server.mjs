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
const cache = {}; // { [repo]: { etag, releases, rendered: { [release.id]: html } } }

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

// fetches the releases from GitHub API and caches them
// uses If-None-Match header to avoid unnecessary requests
const fetchReleases = async (repo, token, force = false) => {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!force && cache[repo]?.etag
      ? { "If-None-Match": cache[repo].etag }
      : {}),
  };

  const res = await fetch(url, { headers });
  console.log(
    `[GitHub Releases] ${repo}: ${res.status} | Remaining requests: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
  );

  if (res.status === 304) return cache[repo].releases;
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw Object.assign(new Error("rateLimited"), { rateLimited: true });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);

  const releases = await res.json();
  cache[repo] = {
    etag: res.headers.get("etag"),
    releases,
    rendered: cache[repo]?.rendered || {},
  };
  return releases;
};

const repoExists = async (repo, token) => {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status === 200;
};

// Fetches markdown from GitHub API and converts it to HTML
const fetchMd = async (md, repo, token) => {
  if (!md) return "";
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text: md, mode: "gfm", context: repo }),
  });

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    rateLimitHit = true;
    console.error(`[Markdown API] Rate limit hit`);
    return `<pre>${md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }

  if (!res.ok) {
    console.error(`GitHub markdown API error: ${res.status}`);
    return `<pre>${md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }

  return res.text();
};

// Fetches and caches the rendered HTML for a release
const fetchCache = async (release, repo, token) => {
  const rendered = (cache[repo].rendered ??= {});

  if (rendered[release.id]) return rendered[release.id];
  if (rendered[`promise_${release.id}`])
    return await rendered[`promise_${release.id}`];

  const promise = fetchMd(release.body, repo, token);
  rendered[`promise_${release.id}`] = promise;

  const html = await promise;
  rendered[release.id] = html;
  delete rendered[`promise_${release.id}`];

  return html;
};

// Processes a single feed/repo and formats the releases
const processFeed = async (repo, cutoff, token, force = false) => {
  try {
    const releases = await fetchReleases(repo, token, force);
    const recent = releases.filter((release) =>
      isValidRelease(release, cutoff)
    );
    const toRender = recent.filter(
      (release) => !cache[repo]?.rendered?.[release.id]
    );
    await Promise.all(
      toRender.map((release) => fetchCache(release, repo, token))
    );

    return {
      project: repo,
      releases: recent.map((release) => ({
        title: release.name || release.tag_name,
        date: release.published_at.slice(0, 10),
        html: cache[repo].rendered?.[release.id] || "",
        flagged: hasWarning(release.body),
      })),
    };
  } catch (err) {
    if (err.rateLimited) {
      return {
        project: `Failed → ${repo}`,
        rateLimited: true,
      };
    }
    if (process.env.NODE_ENV === "development") {
      console.error(err);
    } else {
      console.error(`[Feed] Failed to process ${repo}: ${err.message}`);
    }
    return { project: `Failed → ${repo}`, releases: [] };
  }
};

const cleanCache = async (feeds, cutoff) => {
  // Remove repos no longer in feeds
  for (const repo of Object.keys(cache)) {
    if (!feeds.includes(repo)) {
      console.log(`[Cache] Removing cached data for removed repo: ${repo}`);
      delete cache[repo];
    }
  }

  // Remove old releases from cache
  for (const repo of feeds) {
    if (!cache[repo]) continue;
    const recent =
      cache[repo].releases?.filter(
        (release) => new Date(release.published_at).getTime() >= cutoff
      ) || [];
    cache[repo].releases = recent;
    const ids = new Set(recent.map((release) => release.id));
    for (const key of Object.keys(cache[repo].rendered || {})) {
      if (!key.startsWith("promise_") && !ids.has(Number(key)))
        delete cache[repo].rendered[key];
    }
  }
};

// Updates all feeds and cleans the cache
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

// Renders the homepage with the current feed data
const renderHomepage = async (res, errorMessage = null) => {
  const { feeds, daysWindow, githubToken, cutoff } =
    await loadConfigAndCutoff();
  const feedData = feeds.map((repo) => {
    const recent = filterRecentReleases(cache[repo]?.releases || [], cutoff);
    const rendered = cache[repo]?.rendered ?? {};
    const display = recent
      .map((release) => ({
        title: release.name || release.tag_name,
        date: release.published_at.slice(0, 10),
        html: rendered[release.id] || "<i>Loading...</i>",
        flagged: hasWarning(release.body),
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
  await updateAllFeeds(true); // force fetch
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
  setInterval(updateAllFeeds, 60 * 60 * 1000); // 1 hour
  app.listen(port, () =>
    console.log(`Server running at http://localhost:${port} \n`)
  );
})();
