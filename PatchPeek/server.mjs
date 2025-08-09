import express from "express";
import path from "path";


const app = express();
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

const repos = [
  { owner: "LDannijs", repo: "PatchPeek" },
  { owner: "nodejs", repo: "node" },
  // Add more repos as needed
];

async function fetchReleases(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    headers: {
      "Accept": "application/vnd.github.html+json",
      // "Authorization": `token YOUR_GITHUB_TOKEN` // Optional for rate limits
    }
  });

  if (!res.ok) throw new Error(`GitHub API error (${owner}/${repo}): ${res.status}`);
  return res.json();
}

// In-memory store for releases data
let cachedData = [];

// Function to refresh cached data for all repos
async function refreshAllReleases() {
  console.log("Refreshing GitHub releases cache...");
  try {
    const results = await Promise.all(
      repos.map(async ({ owner, repo }) => {
        const releases = await fetchReleases(owner, repo);
        return { owner, repo, releases };
      })
    );
    cachedData = results;
    console.log("GitHub releases cache updated.");
  } catch (err) {
    console.error("Failed to refresh GitHub releases:", err.message);
    // Keep old cachedData on failure
  }
}

// Initial fetch on startup
refreshAllReleases();

// Refresh every hour (3600000 ms)
setInterval(refreshAllReleases, 3600000);

app.get("/", (req, res) => {
  res.render("index", { allReleases: cachedData });
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));