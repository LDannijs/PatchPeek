import express from "express";
import path from "path";
import fs from "fs/promises";
import pLimit from "p-limit";

const app = express();
const configPath = path.resolve("./data/config.json");
const limit = pLimit(5);

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

let config = { repos: [], daysWindow: 31, githubToken: "" };
let cachedData = [];
let lastUpdateTime = null;
let rateLimited = false;

const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];

async function loadConfig() {
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch {
    await saveConfig();
  }
}

async function saveConfig() {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function cutoffDate(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

async function fetchReleases(repo, daysWindow = config.daysWindow) {
  const allReleases = [];
  const cutoff = cutoffDate(daysWindow);

  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github.html+json",
          Authorization: config.githubToken
            ? `token ${config.githubToken}`
            : undefined,
        },
      }
    );

    console.log(
      `${repo}: ${res.status} | Remaining: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
    );

    if (
      res.status === 403 &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      rateLimited = true;
      return allReleases;
    }

    if (!res.ok) throw new Error(`GitHub API error (${repo}): ${res.status}`);

    const releases = await res.json();
    if (!releases.length) break;

    for (const r of releases) {
      if (r.draft || r.prerelease) continue;
      if (new Date(r.published_at) < cutoff) return allReleases;

      const body = (r.body_html || "").toLowerCase();
      r.flagged = keywords.some((kw) => body.includes(kw));

      allReleases.push(r);
    }
  }

  return allReleases;
}

function sortReleases(releases) {
  return releases.sort((a, b) => {
    if (a.flagged && !b.flagged) return -1;
    if (!a.flagged && b.flagged) return 1;
    return new Date(b.published_at) - new Date(a.published_at);
  });
}

async function refreshAllReleases() {
  console.log("Refreshing GitHub releases...");
  const errors = [];
  const cutoff = cutoffDate(config.daysWindow);

  const results = await Promise.all(
    config.repos.map((repo) =>
      limit(async () => {
        try {
          const releases = await fetchReleases(repo);
          return {
            repo,
            releases: sortReleases(releases),
            releaseCount: releases.length,
            hasFlagged: releases.some((r) => r.flagged),
          };
        } catch (err) {
          console.error(`Failed to refresh ${repo}: ${err.message}`);
          errors.push(`${repo} → ${err.message}`);
          return null;
        }
      })
    )
  );

  cachedData = results
    .filter((r) => r && r.releaseCount > 0)
    .sort((a, b) => b.releaseCount - a.releaseCount);

  cachedData.forEach((feed) => {
    feed.releases = feed.releases.filter(
      (r) => new Date(r.published_at) >= cutoff
    );
    feed.releaseCount = feed.releases.length;
    feed.hasFlagged = feed.releases.some((r) => r.flagged);
  });
  cachedData = cachedData.filter((feed) => feed.releaseCount > 0);

  refreshAllReleases.lastErrors = errors;
  lastUpdateTime = new Date().toLocaleString();
}

function renderIndex(res, { errorMessage } = {}) {
  res.render("index", {
    allReleases: cachedData,
    daysWindow: config.daysWindow,
    repoList: [...config.repos].sort((a, b) => a.localeCompare(b)),
    errorMessage:
      errorMessage ||
      (rateLimited
        ? "Rate Limited. Either wait or use a GitHub token."
        : refreshAllReleases.lastErrors?.join("; ")) ||
      null,
    lastUpdateTime,
  });
}

function normalizeRepoSlug(input) {
  const trimmed = input.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)(?:\/.*)?$/
  );
  return match ? `${match[1]}/${match[2]}` : trimmed;
}

app.get("/", async (req, res) => {
  if (cachedData.length === 0) await refreshAllReleases();
  renderIndex(res);
});

app.get("/debug", (req, res) => res.json(cachedData));

app.post("/add-repo", async (req, res) => {
  const repoInput = normalizeRepoSlug(req.body.repoSlug);

  if (config.repos.includes(repoInput))
    return renderIndex(res, { errorMessage: "Repository already added" });

  try {
    await fetchReleases(repoInput);
    config.repos.push(repoInput);
    await saveConfig();
    res.redirect("/");
  } catch (err) {
    renderIndex(res, { errorMessage: `Failed to fetch: ${err.message}` });
  }
});

app.post("/remove-repo", async (req, res) => {
  const repo = req.body.repoSlug.trim();
  config.repos = config.repos.filter((r) => r !== repo);
  cachedData = cachedData.filter((r) => r.repo !== repo);
  await saveConfig();
  res.redirect("/");
});

app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!isNaN(days) && days > 0) {
    config.daysWindow = days;
    await saveConfig();
    await refreshAllReleases();
  }
  res.redirect("/");
});

app.post("/update-token", async (req, res) => {
  const token = req.body.githubToken?.trim();
  if (token && !/^github_pat_|^ghp_/.test(token)) {
    return renderIndex(res, {
      errorMessage:
        "Invalid GitHub token format. It should start with 'github_pat_' or 'ghp_'.",
    });
  }
  config.githubToken = token;
  await saveConfig();
  res.redirect("/");
});

(async () => {
  await loadConfig();
  await refreshAllReleases();
  setInterval(refreshAllReleases, 60 * 60 * 1000); // 1 hour
  app.listen(3000, () =>
    console.log(`\nServer running at http://localhost:3000\n`)
  );
})();
