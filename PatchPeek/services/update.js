import { loadConfigAndCutoff } from "./config.js";
import {
  cache,
  hasWarning,
  isValidRelease,
  filterRecentReleases,
  cleanCache,
  fetchReleasesWithCache,
  getRenderedReleaseHtml,
} from "./github.js";

let lastUpdateTime = 0;
let rateLimitHit = false;
export const getRateLimitStatus = () => rateLimitHit;

export const updateAllFeeds = async (force = false) => {
  try {
    const { feeds, githubToken, cutoff } = await loadConfigAndCutoff();
    const results = await Promise.all(
      feeds.map((repo) => processFeed(repo, cutoff, githubToken, force))
    );
    rateLimitHit = results.some((r) => r.rateLimited);
    await cleanCache(feeds, cutoff);
  } catch (err) {
    console.error("[Background Fetch] Error:", err);
  } finally {
    lastUpdateTime = Date.now();
    console.log(" ");
  }
};

export const processFeed = async (repo, cutoff, token, force = false) => {
  try {
    const releases = await fetchReleasesWithCache(repo, token, force);
    const recent = releases.filter((r) => isValidRelease(r, cutoff));
    const toRender = recent.filter((r) => !cache[repo]?.rendered?.[r.id]);
    await Promise.all(
      toRender.map((r) => getRenderedReleaseHtml(r, repo, token))
    );

    return {
      project: repo,
      releases: recent.map((r) => ({
        title: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        html: cache[repo].rendered?.[r.id] || "",
        flagged: hasWarning(r.body),
      })),
    };
  } catch (err) {
    if (err.rateLimited) {
      return {
        project: `Failed → ${repo}`,
        rateLimited: true,
      };
    }
    if (process.env.NODE_ENV === "development") {
      console.error(err);
    } else {
      console.error(`[Feed] Failed to process ${repo}: ${err.message}`);
    }
    return { project: `Failed → ${repo}`, releases: [] };
  }
};

export const renderHomepage = async (res, errorMessage = null) => {
  const { feeds, daysWindow, githubToken, cutoff } =
    await loadConfigAndCutoff();
  const feedData = feeds.map((repo) => {
    const recent = filterRecentReleases(cache[repo]?.releases || [], cutoff);
    const rendered = cache[repo]?.rendered ?? {};
    const display = recent
      .map((r) => ({
        title: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        html: rendered[r.id] || "<i>Loading...</i>",
        flagged: hasWarning(r.body),
      }))
      .filter((r) => r.html);

    return {
      project: repo,
      releases: display,
      releaseCount: display.length,
      breakingCount: display.filter((r) => r.flagged).length,
    };
  });

  const feedsWithReleases = feedData
    .filter((f) => f.releaseCount > 0)
    .sort((a, b) =>
      b.breakingCount === a.breakingCount
        ? b.releaseCount - a.releaseCount
        : b.breakingCount - a.breakingCount
    );

  res.render("index", {
    rateLimitHit,
    isAuthenticated: !!githubToken,
    feedsList: feeds,
    feedsWithReleases,
    daysWindow,
    lastUpdateTime,
    now: Date.now(),
    errorMessage,
  });
};
