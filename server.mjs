import express from "express";
import fs from "fs/promises";
import path from "path";
import RSSParser from "rss-parser";
import TurndownService from "turndown";
import { marked } from "marked";

const app = express();
const port = 3000;

const feedsFile = path.resolve("./feeds.json");
const turndown = new TurndownService();
const parser = new RSSParser({ customFields: { item: ["content"] } });

const daysWindow = 30;
const cutoff = Date.now() - daysWindow * 86400000;

app.use(express.urlencoded({ extended: true }));

// Helper to read feeds list
async function readFeeds() {
  try {
    const data = await fs.readFile(feedsFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Helper to save feeds list
async function saveFeeds(feeds) {
  await fs.writeFile(feedsFile, JSON.stringify(feeds, null, 2));
}

// Helper: timestamp of an item
function getTimestamp(item) {
  return (
    new Date(
      item.isoDate ||
        item.pubDate ||
        item.published ||
        item.updated ||
        item["dc:date"] ||
        0
    ).getTime() || 0
  );
}

// Helper: detect breaking changes
function hasWarning(text) {
  const keywords = [
    "breaking change",
    "breaking changes",
    "caution",
    "warning",
    "important",
  ];
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

// GET / => show UI with feeds and releases
app.get("/", async (req, res) => {
  const feeds = await readFeeds();

  // Fetch release info for all feeds in parallel
  const feedData = await Promise.all(
    feeds.map(async (feedUrl) => {
      try {
        const feed = await parser.parseURL(feedUrl);
        const project = feed.title.replace("Releases ·", "").trim();
        const recentItems = feed.items.filter(
          (item) => getTimestamp(item) >= cutoff
        );
        const releases = recentItems.map((item) => {
          const date = new Date(getTimestamp(item)).toISOString().slice(0, 10);
          const title = item.title;
          const html = item.content || item["content:encoded"] || "";
          const md = turndown.turndown(html).trim();
          const flagged = hasWarning(md);
          return { date, title, md, flagged };
        });
        const breakingCount = releases.filter((r) => r.flagged).length;
        return {
          project,
          feedUrl,
          releases,
          breakingCount,
          releaseCount: releases.length,
        };
      } catch (e) {
        return {
          project: `Failed to load feed: ${feedUrl}`,
          feedUrl,
          releases: [],
          breakingCount: 0,
          releaseCount: 0,
        };
      }
    })
  );

  // Render simple HTML page with form and results
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RSS Feed Manager & Releases</title>
<style>
  body { font-family: Arial, sans-serif; margin: 2rem; background: #f9f9f9; }
  summary { cursor: pointer; font-weight: bold; font-size: 1.1em; padding: 0.5em; background: #eee; border-radius: 4px; }
  details { margin-bottom: 1rem; background: #fff; padding: 1em; border-radius: 6px; box-shadow: 0 2px 6px rgb(0 0 0 / 0.1); }
  .release { margin-bottom: 1rem; }
  .flagged { color: red; font-weight: bold; }
  pre { background: #272822; color: #f8f8f2; padding: 1em; overflow-x: auto; border-radius: 4px; }
  form { margin-bottom: 2rem; }
  label { display: block; margin-bottom: 0.5rem; }
  input[type=text] { width: 80%; padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  .error { color: red; }
</style>
</head>
<body>
  <h1>RSS Feed Manager & Release Summaries (Last ${daysWindow} Days)</h1>
  
  <form method="POST" action="/add-feed">
    <label for="feedUrl">Add a new GitHub releases Atom feed URL:</label>
    <input id="feedUrl" name="feedUrl" type="text" placeholder="https://github.com/user/repo/releases.atom" required />
    <button type="submit">Add Feed</button>
  </form>

  <h2>Current Feeds</h2>
  <ul>
  ${
    feeds
      .map(
        (f) => `
    <li>
      <code>${f}</code>
      <form method="POST" action="/remove-feed" style="display:inline; margin-left:1em;">
        <input type="hidden" name="feedUrl" value="${f}" />
        <button type="submit" onclick="return confirm('Remove feed?');">Remove</button>
      </form>
    </li>
  `
      )
      .join("") || "<li><em>No feeds added yet</em></li>"
  }
</ul>


  <h2>Releases</h2>
  ${feedData
    .map((feed) => {
      const breaking = feed.releases.filter((r) => r.flagged);
      const normal = feed.releases.filter((r) => !r.flagged);

      return `
    <details>
      <summary>${feed.project} — ${feed.releaseCount} releases, 
        ${
          feed.breakingCount > 0
            ? `<span class="flagged">${feed.breakingCount} with potential breaking changes ⚠️</span>`
            : "No breaking changes"
        }</summary>
      <div>
        ${breaking
          .map(
            (r) => `
          <details class="release" open>
            <summary>${r.title} (${
              r.date
            }) <span class="flagged">⚠️</span></summary>
            <div>${marked.parse(r.md)}</div>
          </details>
        `
          )
          .join("")}

        ${breaking.length && normal.length ? '<hr style="margin:1em 0" />' : ""}

        ${normal
          .map(
            (r) => `
          <details class="release">
            <summary>${r.title} (${r.date})</summary>
            <div>${marked.parse(r.md)}</div>
          </details>
        `
          )
          .join("")}
      </div>
    </details>
    `;
    })
    .join("")}

</body>
</html>
  `);
});

// POST /add-feed => add a new feed URL
app.post("/add-feed", async (req, res) => {
  const feedUrl = req.body.feedUrl?.trim();
  if (!feedUrl) {
    return res.status(400).send("Feed URL is required");
  }

  const feeds = await readFeeds();
  if (feeds.includes(feedUrl)) {
    return res.redirect("/"); // already exists, just redirect
  }

  // Basic validation for GitHub Atom feed URL pattern
  if (!/^https:\/\/github\.com\/.+\/.+\/releases\.atom$/.test(feedUrl)) {
    return res.status(400).send("Invalid GitHub releases Atom feed URL");
  }

  feeds.push(feedUrl);
  await saveFeeds(feeds);
  res.redirect("/");
});

// POST /remove-feed => remove a feed URL
app.post("/remove-feed", async (req, res) => {
  const feedUrl = req.body.feedUrl?.trim();
  if (!feedUrl) return res.status(400).send("Feed URL is required");

  let feeds = await readFeeds();
  feeds = feeds.filter((f) => f !== feedUrl);
  await saveFeeds(feeds);
  res.redirect("/");
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
