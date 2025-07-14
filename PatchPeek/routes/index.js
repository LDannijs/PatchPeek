import express from "express";
import {
  readConfig,
  saveConfig,
  updateConfigField,
} from "../services/config.js";
import { repoExists, cleanCache } from "../services/github.js";
import { updateAllFeeds, renderHomepage } from "../services/update.js";

const router = express.Router();

router.get("/", async (_, res) => {
  res.set("Cache-Control", "no-store");
  await renderHomepage(res);
});

router.post("/add-feed", async (req, res) => {
  const raw = req.body.feedSlug?.trim();
  const match = raw?.match(
    /^(?:https:\/\/github\.com\/)?([^/]+\/[^/]+?)(?:\.git|\/.*)?$/
  );
  const config = await readConfig();

  if (!raw) return await renderHomepage(res, "Repository is required");
  if (!match)
    return await renderHomepage(res, "Invalid GitHub repository format");

  const repo = match[1];
  if (config.feeds.includes(repo))
    return await renderHomepage(res, "Repository is already in your list");
  if (!(await repoExists(repo, config.githubToken)))
    return await renderHomepage(res, "GitHub repository not found");

  config.feeds.push(repo);
  await saveConfig(config);
  await updateAllFeeds();
  res.redirect("/");
});

router.post("/remove-feed", async (req, res) => {
  const config = await readConfig();
  const cutoff = Date.now() - config.daysWindow * 86400000;
  const repoSlugs = [].concat(req.body.feedSlug || []);
  config.feeds = config.feeds.filter((f) => !repoSlugs.includes(f));
  await saveConfig(config);
  await cleanCache(config.feeds, cutoff);
  res.redirect("/");
});

router.post("/update-days", async (req, res) => {
  const days = parseInt(req.body.daysWindow, 10);
  if (!isNaN(days) && days > 0) await updateConfigField("daysWindow", days);
  await updateAllFeeds(true);
  res.redirect("/");
});

router.post("/update-token", async (req, res) => {
  await updateConfigField("githubToken", req.body.githubToken?.trim() || "");
  await updateAllFeeds();
  res.redirect("/");
});

export default router;
