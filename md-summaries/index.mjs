import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import RSSParser from "rss-parser";
import TurndownService from "turndown";
import config from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parser = new RSSParser({ customFields: { item: ["content"] } });
const turndown = new TurndownService();
const cutoff = Date.now() - config.daysWindow * 86400000;

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

function hasWarning(text) {
  const keywords = [
    "breaking change",
    "breaking changes",
    "caution",
    "important",
  ];
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

await fs.mkdir(path.join(__dirname, config.outputDir), { recursive: true });

for (const feedUrl of config.feeds) {
  const feed = await parser.parseURL(feedUrl);
  const project = feed.title.replace("Releases ·", "").trim();
  const filename = `summary-${feedUrl.split("/").slice(3, 5).join("-")}.md`;
  const outFile = path.join(__dirname, config.outputDir, filename);

  const recentItems = feed.items.filter((item) => getTimestamp(item) >= cutoff);
  const releaseCount = recentItems.length;

  let output = `# ${project} – Release Summary (Last ${config.daysWindow} Days)\n\n`;
  output += `Total releases: **${releaseCount}**\n\n`;

  // Filter releases with warning keywords
  const flagged = recentItems.filter((item) => {
    const html = item.content || item["content:encoded"] || "";
    const md = turndown.turndown(html);
    return hasWarning(md);
  });

  if (flagged.length) {
    output += `## ⚠️ Releases with possible breaking changes or warnings:\n\n`;
    for (const item of flagged) {
      const date = new Date(getTimestamp(item)).toISOString().slice(0, 10);
      const title = item.title;
      const html = item.content || item["content:encoded"] || "";
      const md = turndown.turndown(html).trim();

      output += `### ${title} (${date})\n\n${md}\n\n---\n\n`;
    }
  } else {
    output += "_No breaking changes or warnings found in recent releases._\n";
  }

  await fs.writeFile(outFile, output);
  console.log(`📝 Wrote release summary to ${outFile}`);
}
