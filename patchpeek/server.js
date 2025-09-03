import express from "express";
import path from "path";
import fs from "fs/promises";
import pLimit from "p-limit";

const app = express();
const port = 3000;
const configPath = path.resolve("./patchpeek/data/config.json");
const limit = pLimit(5);

app.set("view engine", "ejs");
app.set("views", path.resolve("./patchpeek/views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./patchpeek/public")));

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
      `${repo}: ${res.status} | Remaining tokens: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
    );

    if (
      res.status === 403 &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      rateLimited = true;
      return allReleases;
    }

    if (res.status === 404) {
      throw new Error(`Repository "${repo}" does not exist or is private.`);
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

async function refreshReleases(reposToRefresh = config.repos) {
  console.log(`Refreshing ${reposToRefresh.length} repositories`);
  const cutoff = cutoffDate(config.daysWindow);
  const errors = [];

  await Promise.all(
    reposToRefresh.map((repo) =>
      limit(async () => {
        try {
          const releases = (await fetchReleases(repo)).filter(
            (r) => new Date(r.published_at) >= cutoff
          );

          releases.sort((a, b) => {
            if (a.flagged && !b.flagged) return -1;
            if (!a.flagged && b.flagged) return 1;
            return new Date(b.published_at) - new Date(a.published_at);
          });

          const entry = {
            repo,
            releases,
            releaseCount: releases.length,
            hasFlagged: releases.some((r) => r.flagged),
          };

          cachedData = [
            ...cachedData.filter((f) => f.repo !== repo),
            ...(entry.releaseCount > 0 ? [entry] : []),
          ];
        } catch (err) {
          console.error(`Failed to refresh ${repo}: ${err.message}`);
          errors.push(`${err.message}`);
        }
      })
    )
  );

  cachedData.sort((a, b) => b.releaseCount - a.releaseCount);
  refreshReleases.lastErrors = errors;
  lastUpdateTime = new Date().toLocaleString();
  console.log(" ");
}

function renderIndex(res, { errorMessage } = {}) {
  res.render("index", {
    allReleases: cachedData,
    daysWindow: config.daysWindow,
    repoList: [...config.repos].sort((a, b) => a.localeCompare(b)),
    errorMessage: errorMessage || refreshReleases.lastErrors || null,
    rateLimited,
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
  if (cachedData.length === 0) await refreshReleases();
  renderIndex(res);
});

app.get("/debug", (req, res) => res.json(cachedData));

app.post("/add-repo", async (req, res) => {
  const repoInput = normalizeRepoSlug(req.body.repoSlug);

  if (config.repos.includes(repoInput))
    return renderIndex(res, { errorMessage: ["Repository already added"] });

  try {
    await refreshReleases([repoInput]);
    config.repos.push(repoInput);
    await saveConfig();
    res.redirect("/");
  } catch (err) {
    renderIndex(res, { errorMessage: [`Failed to fetch: ${err.message}`] });
  }
});

app.post("/remove-repo", async (req, res) => {
  const repo = req.body.repoSlug.trim();
  config.repos = config.repos.filter((r) => r !== repo);
  cachedData = cachedData.filter((r) => r.repo !== repo);
  if (refreshReleases.lastErrors?.length) {
    refreshReleases.lastErrors = refreshReleases.lastErrors.filter(
      (err) => !err.includes(repo)
    );
  }
  await saveConfig();
  res.redirect("/");
});

app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!isNaN(days) && days > 0) {
    config.daysWindow = days;
    await saveConfig();
    await refreshReleases();
  }
  res.redirect("/");
});

app.post("/update-token", async (req, res) => {
  const token = req.body.githubToken?.trim();
  if (token && !/^github_pat_|^ghp_/.test(token)) {
    return renderIndex(res, {
      errorMessage: [
        "Invalid GitHub token format. It should start with 'github_pat_' or 'ghp_'.",
      ],
    });
  }
  config.githubToken = token;
  await saveConfig();
  res.redirect("/");
});

(async () => {
  await loadConfig();
  await refreshReleases();
  setInterval(refreshReleases, 60 * 60 * 1000); // 1 hour
  app.listen(port, () =>
    console.log(`Server running at http://0.0.0.0:${port}\n`)
  );
})();
