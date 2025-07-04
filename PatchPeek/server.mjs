import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const port = 3000;
const configFile = path.resolve("./config.json");

const defaultConfig = {
  feeds: [],
  daysWindow: 30,
  githubToken: "",
};

const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

async function readConfig() {
  try {
    const raw = await fs.readFile(configFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    await fs.writeFile(configFile, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
}

async function saveConfig(config) {
  await fs.writeFile(configFile, JSON.stringify(config, null, 2));
}

const hasWarning = (text = "") => {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
};

const cache = {}; // { [repo]: { etag, releases, lastFetched, rendered: { [release.id]: html } } }

async function fetchReleasesWithCache(repo, githubToken) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
  if (cache[repo]?.etag) headers["If-None-Match"] = cache[repo].etag;

  const res = await fetch(url, { headers });

  // Log rate limit info
  console.log(
    `[GitHub Releases] ${repo}: ${res.status} | Remaining: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
  );

  if (res.status === 304) {
    cache[repo].lastFetched = Date.now();
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
  // Keep previous rendered HTML if available
  const prevRendered = cache[repo]?.rendered || {};
  cache[repo] = {
    etag: res.headers.get("etag"),
    releases,
    lastFetched: Date.now(),
    rendered: prevRendered,
  };
  return releases;
}

// Background fetcher
async function updateAllFeeds() {
  const { feeds, githubToken } = await readConfig();
  await Promise.all(
    feeds.map(async (repo) => {
      try {
        await fetchReleasesWithCache(repo, githubToken);
      } catch (e) {
        // Ignore errors, handled on demand
      }
    })
  );
}

// Refresh every 10 minutes
setInterval(updateAllFeeds, 10 * 60 * 1000);
// Initial fetch
updateAllFeeds();

// Render markdown to GitHub-flavored HTML via GitHub API
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

  // Log rate limit info
  console.log(
    `[GitHub Markdown] ${repo}: ${res.status} | Remaining: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
  );

  if (!res.ok) {
    console.error(`GitHub markdown API error: ${res.status}`);
    return `<pre>${md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`;
  }
  return res.text();
}

app.get("/", async (_, res) => {
  const { feeds, daysWindow, githubToken } = await readConfig();
  const cutoff = Date.now() - daysWindow * 86400000;

  let rateLimitHit = false;
  let rateLimitReset = 0;

  const feedData = await Promise.all(
    feeds.map(async (repo) => {
      try {
        let items;
        if (cache[repo]?.releases) {
          items = cache[repo].releases;
        } else {
          items = await fetchReleasesWithCache(repo, githubToken);
        }
        const recent = items.filter(
          (r) =>
            !r.draft &&
            !r.prerelease &&
            new Date(r.published_at).getTime() >= cutoff
        );

        // Render markdown only if not already cached
        if (!cache[repo].rendered) cache[repo].rendered = {};
        const releases = await Promise.all(
          recent.map(async (r) => {
            let html = cache[repo].rendered[r.id];
            if (!html) {
              html = await renderMd(r.body ?? "", repo, githubToken);
              cache[repo].rendered[r.id] = html;
            }
            return {
              title: r.name || r.tag_name,
              date: r.published_at.slice(0, 10),
              html,
              flagged: hasWarning(r.body),
            };
          })
        );

        return {
          project: repo,
          releases,
          releaseCount: releases.length,
          breakingCount: releases.filter((r) => r.flagged).length,
        };
      } catch (e) {
        if (e.rateLimited) {
          rateLimitHit = true;
          rateLimitReset = Math.max(rateLimitReset, e.resetEpoch);
        }
        return {
          project: `Failed → ${repo}`,
          releases: [],
          releaseCount: 0,
          breakingCount: 0,
        };
      }
    })
  );

  const feedsWithReleases = feedData.filter((f) => f.releaseCount > 0);
  feedsWithReleases.sort((a, b) =>
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
  });
});

app.post("/add-feed", async (req, res) => {
  const raw = req.body.feedSlug?.trim();
  if (!raw) return res.status(400).send("Repository required");

  const match = raw.match(
    /^(?:https:\/\/github\.com\/)?([^/]+\/[^/]+?)(?:\.git|\/.*)?$/
  );
  if (!match) return res.status(400).send("Invalid GitHub repository");

  const repo = match[1];
  const config = await readConfig();

  if (!config.feeds.includes(repo)) {
    config.feeds.push(repo);
    await saveConfig(config);
  }
  res.redirect("/");
});

app.post("/remove-feed", async (req, res) => {
  let repos = req.body.feedSlug;
  if (!repos) return res.redirect("/");
  if (!Array.isArray(repos)) repos = [repos];

  const config = await readConfig();
  config.feeds = config.feeds.filter((f) => !repos.includes(f));
  await saveConfig(config);
  res.redirect("/");
});

app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!isNaN(days) && days > 0) {
    const config = await readConfig();
    config.daysWindow = days;
    await saveConfig(config);
  }
  res.redirect("/");
});

app.post("/update-token", async (req, res) => {
  const token = req.body.githubToken?.trim();
  const config = await readConfig();
  config.githubToken = token || "";
  await saveConfig(config);
  res.redirect("/");
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);
