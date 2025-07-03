import express from "express";
import fs from "fs/promises";
import path from "path";
import "dotenv/config";

const app = express();
const port = 3000;

const configFile = path.resolve("./config.json");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));

// ----------- Helpers --------------------------------------------------------

async function readConfig() {
  try {
    const raw = await fs.readFile(configFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Default config if file missing or invalid
    return { feeds: [], daysWindow: 30 };
  }
}

async function saveConfig(config) {
  await fs.writeFile(configFile, JSON.stringify(config, null, 2));
}

const toTimestamp = (iso) => new Date(iso ?? 0).getTime() || 0;

const hasWarning = (text = "") => {
  const keywords = [
    "breaking change",
    "breaking changes",
    "caution",
    "important",
  ];
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
};

// Fetch up to 100 releases from a GitHub repo
async function fetchReleases(repo) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = GITHUB_TOKEN
    ? { Authorization: `Bearer ${GITHUB_TOKEN}` }
    : {};
  const res = await fetch(url, { headers });

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const resetEpoch = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const err = new Error("rateLimited");
    err.rateLimited = true;
    err.resetEpoch = resetEpoch;
    throw err;
  }

  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.json();
}

// Render markdown to GitHub-flavored HTML via GitHub API
async function renderMarkdownWithGitHubAPI(md, repo) {
  if (!md) return "";
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
    body: JSON.stringify({ text: md, mode: "gfm", context: repo }),
  });

  if (!res.ok) {
    console.error(`GitHub markdown API error: ${res.status}`);
    // Return escaped raw markdown as fallback
    return `<pre>${md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`;
  }
  return res.text();
}

// Render main HTML template with injected content
async function renderTemplate({ content, daysWindow, feedsList }) {
  const tpl = await fs.readFile(path.resolve("./views/index.html"), "utf-8");
  return tpl
    .replace("{{content}}", content)
    .replace("{{daysWindow}}", daysWindow)
    .replace("{{feedsList}}", feedsList);
}

// ----------- Routes ---------------------------------------------------------

app.get("/", async (_, res) => {
  const { feeds, daysWindow } = await readConfig();
  const cutoff = Date.now() - daysWindow * 86_400_000;

  let rateLimitHit = false;
  let rateLimitReset = 0;

  if (!GITHUB_TOKEN) {
    const banner = `<p class="tokenMissingBanner">
      ⚠️ GitHub token missing! Please set your GITHUB_TOKEN environment variable to enable API requests.
    </p>`;
    const feedsList = feeds.length
      ? feeds.map((f) => `<li><code class="feeds">${f}</code></li>`).join("")
      : "<li><em>None yet</em></li>";
    return res.send(
      await renderTemplate({
        content: banner,
        daysWindow,
        feedsList,
      })
    );
  }

  const feedData = await Promise.all(
    feeds.map(async (repo) => {
      try {
        const items = await fetchReleases(repo);
        const recent = items.filter(
          (r) => !r.draft && toTimestamp(r.published_at) >= cutoff
        );

        const releases = await Promise.all(
          recent.map(async (r) => ({
            title: r.name || r.tag_name,
            date: r.published_at.slice(0, 10),
            html: await renderMarkdownWithGitHubAPI(r.body ?? "", repo),
            flagged: hasWarning(r.body),
          }))
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
    b.breakingCount !== a.breakingCount
      ? b.breakingCount - a.breakingCount
      : b.releaseCount - a.releaseCount
  );

  const content = feedsWithReleases
    .map(({ project, releases, releaseCount, breakingCount }) => {
      const breaking = releases.filter((r) => r.flagged);
      const normal = releases.filter((r) => !r.flagged);
      return `
        <details class="wrapper">
          <summary class="feedMain">
            <img class="avatar" src="https://github.com/${
              project.split("/")[0]
            }.png" alt="${project}" />
            <p class="project">${project}</p>
            <p class="releaseCount ${breakingCount ? "flagged" : ""}">
              ${releaseCount} releases${breakingCount ? " ⚠️" : ""}
            </p>
          </summary>
          <div class="releaseDiv">
            ${[...breaking, ...normal]
              .map(
                ({ title, date, html, flagged }) => `
                  <details class="release" open>
                    <summary>
                      ${title} (${date})${
                  flagged ? '<span class="flagged">⚠️</span>' : ""
                }
                    </summary>
                    <div class="markdown-body">${html}</div>
                  </details>`
              )
              .join("")}
          </div>
        </details>`;
    })
    .join("");

  const banner = rateLimitHit
    ? `<p class="rateLimitBanner">⚠️ GitHub API rate limit exceeded.</p>`
    : "";

  const feedsList = feedData.length
    ? feedData
        .map(
          ({ project }) => `
      <li>
        <form method="POST" action="/remove-feed" onchange="this.submit()">
          <code class="feeds">
            <input type="checkbox" class="feedcheck" checked />
            <p class="feedtext">${project}</p>
          </code>
          <input type="hidden" name="feedUrl" value="${project}" />
        </form>
      </li>`
        )
        .join("")
    : "<li><em>None yet</em></li>";

  res.send(
    await renderTemplate({
      content: banner + content,
      daysWindow,
      feedsList,
    })
  );
});

app.post("/add-feed", async (req, res) => {
  const raw = req.body.feedUrl?.trim();
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
  let repos = req.body.feedUrl;
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

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);
