const keywords = [
  "breaking change",
  "breaking changes",
  "caution",
  "important",
];
export const cache = {};

export const hasWarning = (text) =>
  keywords.some((kw) => text?.toLowerCase().includes(kw));

export const isValidRelease = (r, cutoff) =>
  !r.draft && !r.prerelease && new Date(r.published_at).getTime() >= cutoff;

export const filterRecentReleases = (releases, cutoff) =>
  releases.filter((r) => isValidRelease(r, cutoff));

export const cleanCache = async (feeds, cutoff) => {
  for (const repo of Object.keys(cache)) {
    if (!feeds.includes(repo)) delete cache[repo];
  }
  for (const repo of feeds) {
    if (!cache[repo]) continue;
    const recent =
      cache[repo].releases?.filter(
        (r) => new Date(r.published_at).getTime() >= cutoff
      ) || [];
    cache[repo].releases = recent;
    const ids = new Set(recent.map((r) => r.id));
    for (const key of Object.keys(cache[repo].rendered || {})) {
      if (!key.startsWith("promise_") && !ids.has(Number(key)))
        delete cache[repo].rendered[key];
    }
  }
};

export const fetchReleasesWithCache = async (repo, token, force = false) => {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!force && cache[repo]?.etag
      ? { "If-None-Match": cache[repo].etag }
      : {}),
  };

  const res = await fetch(url, { headers });
  console.log(
    `[GitHub Releases] ${repo}: ${res.status} | Remaining requests: ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")}`
  );

  if (res.status === 304) return cache[repo].releases;
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw Object.assign(new Error("rateLimited"), { rateLimited: true });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);

  const releases = await res.json();
  cache[repo] = {
    etag: res.headers.get("etag"),
    releases,
    rendered: cache[repo]?.rendered || {},
  };
  return releases;
};

export const repoExists = async (repo, token) => {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status === 200;
};

export const renderMd = async (md, repo, token) => {
  if (!md) return "";
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text: md, mode: "gfm", context: repo }),
  });

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    rateLimitHit = true;
    console.error(`[Markdown API] Rate limit hit`);
    return `<pre>${md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }

  if (!res.ok) {
    console.error(`GitHub markdown API error: ${res.status}`);
    return `<pre>${md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }

  return res.text();
};

export const getRenderedReleaseHtml = async (r, repo, token) => {
  cache[repo].rendered ??= {};
  if (cache[repo].rendered[r.id]) return cache[repo].rendered[r.id];
  if (cache[repo].rendered[`promise_${r.id}`])
    return await cache[repo].rendered[`promise_${r.id}`];

  const promise = renderMd(r.body, repo, token);
  cache[repo].rendered[`promise_${r.id}`] = promise;
  const html = await promise;
  cache[repo].rendered[r.id] = html;
  delete cache[repo].rendered[`promise_${r.id}`];
  return html;
};
