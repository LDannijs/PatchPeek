import express from "express";
import path from "path";
import fs from "fs";

const app = express();
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

const config = JSON.parse(fs.readFileSync("./data/config.json", "utf-8"));

async function fetchReleases(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Accept: "application/vnd.github.html+json",
      Authorization: config.githubToken
        ? `token ${config.githubToken}`
        : undefined,
    },
  });

  if (!res.ok) throw new Error(`GitHub API error (${repo}): ${res.status}`);
  return res.json();
}

let cachedData = [];

async function refreshAllReleases() {
  console.log("Refreshing GitHub releases cache...");
  try {
    const results = await Promise.all(
      config.repos.map(async (repo) => {
        const releases = await fetchReleases(repo);
        return { repo, releases, releaseCount: releases.length };
      })
    );
    cachedData = results;
    console.log("GitHub releases cache updated.");
  } catch (err) {
    console.error("Failed to refresh GitHub releases:", err.message);
  }
}

app.get("/", async (req, res) => {
  if (cachedData.length === 0) {
    await refreshAllReleases();
  }
  res.render("index", { allReleases: cachedData });
});

app.get("/debug", (req, res) => {
  res.json(cachedData);
});

app.post("/add-repo", async (req, res) => {
  const newRepo = req.body.repoSlug.trim();

  if (!config.repos.includes(newRepo)) {
    config.repos.push(newRepo);
    fs.writeFileSync("./data/config.json", JSON.stringify(config, null, 2));
  }
  await refreshAllReleases();
  res.redirect("/");
});

app.post("/remove-repo", async (req, res) => {
  const repoToRemove = req.body.repoSlug.trim();
  config.repos = config.repos.filter((r) => r !== repoToRemove);
  fs.writeFileSync("./data/config.json", JSON.stringify(config, null, 2));
  cachedData = cachedData.filter((item) => item.repo !== repoToRemove);

  await refreshAllReleases();
  res.redirect("/");
});

(async () => {
  await refreshAllReleases();
  setInterval(refreshAllReleases, 60 * 60 * 1000); // 1 hour
  app.listen(3000, () =>
    console.log(`Server running at http://localhost:3000 \n`)
  );
})();
