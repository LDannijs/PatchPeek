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

// --- Config ---
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

// --- Helpers ---
const hasWarning = (text = "") =>
  keywords.some((kw) => text.toLowerCase().includes(kw));

const isValidRelease = (r, cutoff) =>
  !r.draft && !r.prerelease && new Date(r.published_at).getTime() >= cutoff;

const filterRecentReleases = (releases, cutoff) =>
  releases.filter((r) => isValidRelease(r, cutoff));

async function loadConfigAndCutoff() {
  const config = await readConfig();
  const cutoff = Date.now() - config.daysWindow * 86400000;
  return { ...config, cutoff };
}

// --- GitHub API ---
async function fetchReleasesWithCache(repo, githubToken, force = false) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = {
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    ...(!force && cache[repo]?.etag
      ? { "If-None-Match": cache[repo].etag }
      : {}),
  };

  const res = await fetch(url, { headers });
  console.log(
    `[GitHub Releases] ${repo}: ${
      res.status
    } | Remaining requests: ${res.headers.get(
      "x-ratelimit-remaining"
    )}/${res.headers.get("x-ratelimit-limit")}`
  );

  if (res.status === 304) {
    return cache[repo].releases;
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const resetEpoch = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const err = new Error("rateLimited");
    err.rateLimited = true;
    err.resetEpoch = resetEpoch;
    throw err;
  }

  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);

  const releases = await res.json();
  cache[repo] = {
    etag: res.headers.get("etag"),
    releases,
    rendered: cache[repo]?.rendered || {},
  };
  return releases;
}

async function renderMd(md, repo, githubToken) {
  if (!md) return "";
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
    body: JSON.stringify({ text: md, mode: "gfm", context: repo }),
  });
  if (!res.ok) {
    console.error(`GitHub markdown API error: ${res.status}`);
    return `<pre>${md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`;
  }
  return res.text();
}

async function getRenderedReleaseHtml(r, repo, githubToken) {
  cache[repo].rendered ??= {};
  if (cache[repo].rendered[r.id]) return cache[repo].rendered[r.id];
  if (cache[repo].rendered[`promise_${r.id}`])
    return await cache[repo].rendered[`promise_${r.id}`];

  const promise = renderMd(r.body ?? "", repo, githubToken);
  cache[repo].rendered[`promise_${r.id}`] = promise;
  const html = await promise;
  cache[repo].rendered[r.id] = html;
  delete cache[repo].rendered[`promise_${r.id}`];
  return html;
}

async function processFeed(repo, cutoff, githubToken, force = false) {
  try {
    const releases = await fetchReleasesWithCache(repo, githubToken, force);
    const recent = releases.filter((r) => isValidRelease(r, cutoff));
    const recentToRender = recent.filter((r) => !cache[repo]?.rendered?.[r.id]);

    await Promise.all(
      recentToRender.map((r) => getRenderedReleaseHtml(r, repo, githubToken))
    );

    return {
      project: repo,
      releases: recent.map((r) => ({
        title: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        html: cache[repo].rendered?.[r.id] || "",
        flagged: hasWarning(r.body),
      })),
    };
  } catch (err) {
    if (err.rateLimited) {
      return {
        project: `Failed → ${repo}`,
        rateLimited: true,
        resetEpoch: err.resetEpoch,
      };
    }
    console.error(`[Feed] Failed to process ${repo}:`, err);
    return { project: `Failed → ${repo}`, releases: [] };
  }
}

const updateAllFeeds = async (force = false) => {
  try {
    const { feeds, githubToken, cutoff } = await loadConfigAndCutoff();

    let localRateLimitHit = false;

    const results = await Promise.all(
      feeds.map((repo) => processFeed(repo, cutoff, githubToken, force))
    );

    for (const result of results) {
      if (result.rateLimited) {
        localRateLimitHit = true;
      }
    }

    rateLimitHit = localRateLimitHit;

    await cleanCache(feeds, cutoff);
  } catch (err) {
    console.error("[Background Fetch] Unexpected error:", err);
  } finally {
    lastUpdateTime = Date.now();
    console.log(" ");
  }
};

async function cleanCache(feeds, cutoff) {
  // Remove repos no longer in feeds
  for (const repo of Object.keys(cache)) {
    if (!feeds.includes(repo)) {
      console.log(`[Cache] Removing cached data for removed repo: ${repo}`);
      delete cache[repo];
    }
  }

  // Clean old releases and rendered entries
  for (const repo of feeds) {
    if (!cache[repo]) continue;
    const releases = cache[repo].releases || [];
    const recentReleases = releases.filter(
      (r) => new Date(r.published_at).getTime() >= cutoff
    );

    cache[repo].releases = recentReleases;

    const recentIds = new Set(recentReleases.map((r) => r.id));
    for (const key of Object.keys(cache[repo].rendered || {})) {
      if (key.startsWith("promise_")) continue;
      if (!recentIds.has(Number(key))) {
        delete cache[repo].rendered[key];
      }
    }
  }
}

// --- Routes ---
app.get("/", async (_, res) => {
  const { feeds, daysWindow, githubToken, cutoff } =
    await loadConfigAndCutoff();

  res.set("Cache-Control", "no-store");

  const feedData = feeds.map((repo) => {
    const releases = cache[repo]?.releases || [];
    const recent = filterRecentReleases(releases, cutoff);
    const rendered = cache[repo]?.rendered ?? {};
    const display = recent
      .map((r) => ({
        title: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        html: rendered[r.id] || "<i>Loading...</i>",
        flagged: hasWarning(r.body),
      }))
      .filter((r) => r.html); // hide if not yet rendered

    return {
      project: repo,
      releases: display,
      releaseCount: display.length,
      breakingCount: display.filter((r) => r.flagged).length,
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
  });
});

// --- Config Routes ---
app.post("/add-feed", async (req, res) => {
  const raw = req.body.feedSlug?.trim();
  const match = raw?.match(
    /^(?:https:\/\/github\.com\/)?([^/]+\/[^/]+?)(?:\.git|\/.*)?$/
  );
  if (!raw) return res.status(400).send("Repository required");
  if (!match) return res.status(400).send("Invalid GitHub repository");
  const repo = match[1];
  const config = await readConfig();
  if (!config.feeds.includes(repo)) {
    config.feeds.push(repo);
    await saveConfig(config);
  }
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
  await updateConfigField("githubToken", req.body.githubToken?.trim() || "");
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
