import express from "express";
import fs from "fs/promises";
import path from "path";
import RSSParser from "rss-parser";

const app = express();
const port = 3000;

const configFile = path.resolve("./config.json");
const parser = new RSSParser({ customFields: { item: ["content"] } });

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public"))); // serve css file etc.

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
  const kw = ["breaking change", "breaking changes", "caution", "important"];
  const l = md.toLowerCase();
  return kw.some((k) => l.includes(k));
};

const repoName = (url) =>
  url.replace(/^https:\/\/github\.com\//, "").replace(/\/releases\.atom$/, "");

/* ---------- simple template function ---------- */
async function renderTemplate(data) {
  const templatePath = path.resolve("./views/index.html");
  let template = await fs.readFile(templatePath, "utf-8");

  // Replace placeholders
  template = template.replace("{{content}}", data.content);
  template = template.replace("{{daysWindow}}", data.daysWindow);
  template = template.replace("{{feedsList}}", data.feedsList);

  return template;
}

app.get("/", async (_, res) => {
  const config = await readConfig();
  const feeds = config.feeds;
  const daysWindow = config.daysWindow;
  const cutoff = Date.now() - daysWindow * 86_400_000; // 86400000 ms = 1 day

  const feedData = await Promise.all(
    feeds.map(async (feedUrl) => {
      try {
        const feed = await parser.parseURL(feedUrl);
        const project = repoName(feedUrl);
        const recent = feed.items.filter((i) => ts(i) >= cutoff);
        const releases = recent.map((i) => {
          const date = new Date(ts(i)).toISOString().slice(0, 10);
          const html = i.content || i["content:encoded"] || "";
          const flagged = hasWarning(html);
          return { title: i.title, date, html, flagged };
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

  // Filter feedData only for main content — exclude feeds with no releases
  const feedsWithReleases = feedData.filter((feed) => feed.releaseCount > 0);

  // Sort feeds with releases: breakingCount desc, then releaseCount desc
  feedsWithReleases.sort((a, b) => {
    if (b.breakingCount !== a.breakingCount) {
      return b.breakingCount - a.breakingCount;
    }
    return b.releaseCount - a.releaseCount;
  });

  // Generate main content HTML using only feeds with releases
  const content = feedsWithReleases
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
              <summary>${r.title} (${r.date}) <span class="flagged">⚠️</span></summary>
              <div class="markdown-body">${r.html}</div>
            </details>
          `
            )
            .join("")}
          ${breaking.length && normal.length ? '<hr style="margin:1em 0">' : ""}
          ${normal
            .map(
              (r) => `
            <details class="release">
              <summary>${r.title} (${r.date})</summary>
              <div class="markdown-body">${r.html}</div>
            </details>
          `
            )
            .join("")}
        </div>
      </details>
      `;
    })
    .join("");

  // Generate sidebar feed list using all feeds (feedData)
  const feedsList = feedData.length
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
    : "<li><em>None yet</em></li>";

  const html = await renderTemplate({ content, daysWindow, feedsList });

  res.send(html);
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
