import express from "express";
import fs from "fs/promises";
import path from "path";
import RSSParser from "rss-parser";
import TurndownService from "turndown";
import { marked } from "marked";

const app = express();
const port = 3000;

const configFile = path.resolve("./config.json");
const parser = new RSSParser({ customFields: { item: ["content"] } });
const turndown = new TurndownService();

app.use(express.urlencoded({ extended: true }));

/* ---------- helpers ---------- */
async function readConfig() {
  try {
    const raw = await fs.readFile(configFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { feeds: [], daysWindow: 30 };
  }
}

async function saveConfig(config) {
  await fs.writeFile(configFile, JSON.stringify(config, null, 2));
}

const ts = (item) =>
  new Date(
    item.isoDate ||
      item.pubDate ||
      item.published ||
      item.updated ||
      item["dc:date"] ||
      0
  ).getTime() || 0;

const hasWarning = (md) => {
  const kw = [
    "breaking change",
    "breaking changes",
    "caution",
    "warning",
    "important",
  ];
  const l = md.toLowerCase();
  return kw.some((k) => l.includes(k));
};

// neat helper to turn a GitHub releases.atom URL into user/repo
const repoName = (url) =>
  url.replace(/^https:\/\/github\.com\//, "").replace(/\/releases\.atom$/, "");

/* ---------- routes ---------- */
app.get("/", async (_, res) => {
  const config = await readConfig();
  const feeds = config.feeds;
  const daysWindow = config.daysWindow;
  const cutoff = Date.now() - daysWindow * 86_400_000; // 86400000 ms = 1 day

  const feedData = await Promise.all(
    feeds.map(async (feedUrl) => {
      try {
        const feed = await parser.parseURL(feedUrl);
        const project = repoName(feedUrl); // clean name
        const recent = feed.items.filter((i) => ts(i) >= cutoff);
        const releases = recent.map((i) => {
          const date = new Date(ts(i)).toISOString().slice(0, 10);
          const html = i.content || i["content:encoded"] || "";
          const md = turndown.turndown(html).trim();
          return { title: i.title, date, md, flagged: hasWarning(md) };
        });
        return {
          project,
          feedUrl,
          releases,
          releaseCount: releases.length,
          breakingCount: releases.filter((r) => r.flagged).length,
        };
      } catch {
        return {
          project: `Failed → ${repoName(feedUrl)}`,
          feedUrl,
          releases: [],
          releaseCount: 0,
          breakingCount: 0,
        };
      }
    })
  );

  res.send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>RSS Feed Manager & Releases</title>
<style>
  body { font-family: Arial, sans-serif; margin: 2rem; background: #f9f9f9; }
  .layout { display: flex; gap: 2rem; }
  .sidebar { width: 25%; min-width: 240px; }
  .content { width: 75%; }
  details { margin-bottom: 1rem; background: #fff; padding: 1em; border-radius: 6px; box-shadow: 0 2px 6px rgb(0 0 0 / .1); }
  summary { cursor: pointer; font-weight: 700; font-size: 1.1em; padding: .5em; background: #eee; border-radius: 4px; }
  .release { margin-bottom: 1rem; }
  .flagged { color: red; font-weight: 700; }
  form { margin-bottom: 2rem; }
  input[type=text], input[type=number] { width: 75%; padding: .5rem; font-size: 1rem; }
  button { padding: .5rem 1rem; font-size: 1rem; }
  pre { background: #272822; color: #f8f8f2; padding: 1em; overflow-x: auto; border-radius: 4px; }
  .title { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 1rem; }
  label { display: inline-block; margin-bottom: 0.5rem; }
  ul {list-style: none; padding-left: 0; }
  li {margin-bottom: 0.5em: }
</style>
</head>
<body>
  <div class="layout">
    <!-- MAIN CONTENT (left) -->
    <div class="content">
      ${feedData
        .map((feed) => {
          const breaking = feed.releases.filter((r) => r.flagged);
          const normal = feed.releases.filter((r) => !r.flagged);
          return `
          <details>
            <summary>${feed.project} — ${feed.releaseCount} releases, ${
            feed.breakingCount
              ? `<span class="flagged">${feed.breakingCount} with breaking changes ⚠️</span>`
              : "no breaking changes"
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
              ${
                breaking.length && normal.length
                  ? '<hr style="margin:1em 0">'
                  : ""
              }
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
    </div>
    <div class="sidebar">
      <h1>RSS Changelog</h1>
      <form method="POST" action="/update-days" style="margin-left: auto;">
        <label for="daysWindow">Show releases from last</label>
        <input
          type="number"
          id="daysWindow"
          name="daysWindow"
          min="1"
          value="${daysWindow}"
          required
          style="width: 4em; padding: 0.2rem; margin: 0 0.3rem;"
        />
        days
        <button type="submit">Update</button>
      </form>

      <form method="POST" action="/add-feed">
        <label for="feedUrl">Add GitHub releases Atom feed:</label>
        <input
          id="feedUrl"
          name="feedUrl"
          type="text"
          placeholder="https://github.com/user/repo/releases.atom"
          required
        />
        <button type="submit">Add</button>
      </form>

      <h2>Current Feeds</h2>
      <ul style="list-style:none;padding-left:0">
        ${
          feedData.length
            ? feedData
                .map(
                  (f) => `
          <li style="margin-bottom:.5em">
            <form method="POST" action="/remove-feed" onchange="this.submit()" style="display:inline">
              <label>
                <input type="checkbox" checked />
                ${f.project}
              </label>
              <input type="hidden" name="feedUrl" value="${f.feedUrl}" />
            </form>
          </li>`
                )
                .join("")
            : "<li><em>None yet</em></li>"
        }
      </ul>
    </div>
  </div>
</body>
</html>`);
});

/* ---------- add & remove feeds ---------- */
app.post("/add-feed", async (req, res) => {
  const url = req.body.feedUrl?.trim();
  if (!url) return res.status(400).send("Feed URL required");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\.atom$/.test(url))
    return res.status(400).send("Invalid GitHub releases Atom URL");

  const config = await readConfig();
  if (!config.feeds.includes(url)) {
    config.feeds.push(url);
    await saveConfig(config);
  }
  res.redirect("/");
});

app.post("/remove-feed", async (req, res) => {
  let urls = req.body.feedUrl;
  if (!urls) return res.redirect("/"); // nothing sent – ignore
  if (!Array.isArray(urls)) urls = [urls]; // normalise to array
  const config = await readConfig();
  config.feeds = config.feeds.filter((f) => !urls.includes(f));
  await saveConfig(config);

  res.redirect("/");
});

/* ---------- update days window ---------- */
app.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow);
  if (!isNaN(days) && days > 0) {
    const config = await readConfig();
    config.daysWindow = days;
    await saveConfig(config);
  }
  res.redirect("/");
});

/* ---------- start server ---------- */
app.listen(port, () =>
  console.log(`🚀 Server running at http://localhost:${port}`)
);
