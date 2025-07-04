window.addEventListener("DOMContentLoaded", loadFeeds);

async function loadFeeds() {
  const container = document.getElementById("feedsContainer");
  container.innerHTML = "<p class=loading>Loading releases...</p>";

  try {
    const res = await fetch("/api/releases");
    const feeds = await res.json();

    container.innerHTML = "";

    if (feeds.some((feed) => feed.rateLimited)) {
      container.innerHTML += `
        <p class="rateLimitBanner">
          🚨 GitHub API rate limit exceeded. Some results may be missing.
        </p>`;
    }

    if (!Array.isArray(feeds) || feeds.length === 0) {
      container.innerHTML += "<p class=loading>No releases found.</p>";
      return;
    }

    const filteredFeeds = feeds.filter((feed) => feed.releaseCount > 0);

    if (filteredFeeds.length === 0) {
      container.innerHTML += "<p class=loading>No releases found.</p>";
      return;
    }

    filteredFeeds.sort((a, b) => {
      if (b.breakingCount === a.breakingCount) {
        return b.releaseCount - a.releaseCount;
      }
      return b.breakingCount - a.breakingCount;
    });

    // Use template literals to build all the HTML
    const feedsHtml = filteredFeeds
      .map((feed) => {
        const releasesSorted = [
          ...feed.releases.filter((r) => r.flagged),
          ...feed.releases.filter((r) => !r.flagged),
        ];

        const releasesHtml = releasesSorted
          .map(
            (r) => `
        <details class="release" open>
          <summary>
            ${r.title} (${r.date})${r.flagged ? ' <span class="flagged">🚨</span>' : ""}
          </summary>
          <div class="markdown-body">${r.html}</div>
        </details>
      `
          )
          .join("");

        return `
        <details class="wrapper">
          <summary class="feedMain">
            <img class="avatar" src="https://github.com/${feed.project.split("/")[0]}.png" alt="${feed.project}" />
            <p class="project">${feed.project}</p>
            <p class="releaseCount ${feed.breakingCount ? "flagged" : ""}">
              ${feed.releaseCount} releases${feed.breakingCount ? " 🚨" : ""}
            </p>
          </summary>
          <div class="releaseDiv">
            ${releasesHtml}
          </div>
        </details>
      `;
      })
      .join("");

    container.innerHTML += feedsHtml;
  } catch (err) {
    container.innerHTML = `<p style="color: red;">Failed to load feeds</p>`;
    console.error("Error loading releases:", err);
  }
}
