import express from "express";
import path from "path";
import fs from "fs/promises";

const app = express();
const configPath = path.resolve("./data/config.json");
let cachedData = [];

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

let config = { repos: [], daysWindow: 31, githubToken: "" };

const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];

async function loadConfig() {
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    await saveConfig();
  }
}

async function saveConfig() {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

async function fetchReleases(repo, daysWindow = config.daysWindow) {
  const allReleases = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysWindow);

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
      `${repo}: ${res.status} | Remaining requests: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
    );

    if (!res.ok) throw new Error(`GitHub API error (${repo}): ${res.status}`);

    const releases = await res.json();
    if (!releases.length) break;

    for (const r of releases) {
      if (r.draft || r.prerelease) continue;
      if (new Date(r.published_at) < cutoff) return allReleases;

      const lowerBody = (r.body_html || "").toLowerCase();
      r.flagged = keywords.some((kw) => lowerBody.includes(kw));

      allReleases.push(r);
    }
  }

  return allReleases;
}

async function refreshAllReleases() {
  console.log("Refreshing GitHub releases...");
  try {
    const results = await Promise.all(
      config.repos.map(async (repo) => {
        const releases = await fetchReleases(repo);
        releases.sort((a, b) => {
          if (a.flagged && !b.flagged) return -1;
          if (!a.flagged && b.flagged) return 1;
          return new Date(b.published_at) - new Date(a.published_at);
        });
        return {
          repo,
          releases,
          releaseCount: releases.length,
        };
      })
    );
    cachedData = results
      .filter((r) => r.releaseCount > 0)
      .sort((a, b) => b.releaseCount - a.releaseCount);
  } catch (err) {
    console.error("Failed to refresh GitHub releases:", err.message);
  }
}

app.get("/", async (req, res) => {
  if (cachedData.length === 0) {
    await refreshAllReleases();
  }
  res.render("index", {
    allReleases: cachedData,
    daysWindow: config.daysWindow,
  });
});

app.get("/debug", (req, res) => {
  res.json(cachedData);
});

app.post("/add-repo", async (req, res) => {
  const newRepo = req.body.repoSlug.trim();

  if (!config.repos.includes(newRepo)) {
    config.repos.push(newRepo);
    await saveConfig();
  }
  await refreshAllReleases();
  res.redirect("/");
});

app.post("/remove-repo", async (req, res) => {
  const repoToRemove = req.body.repoSlug.trim();
  config.repos = config.repos.filter((r) => r !== repoToRemove);
  await saveConfig();
  cachedData = cachedData.filter((item) => item.repo !== repoToRemove);

  await refreshAllReleases();
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
  const validFormat = !token || /^github_pat_|^ghp_/.test(token);
  if (!validFormat) {
    return res
      .status(400)
      .send(
        "Invalid GitHub token format. It should start with 'github_pat_' or 'ghp_'."
      );
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
    console.log(`Server running at http://localhost:3000 \n`)
  );
})();
