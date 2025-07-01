export default {
  feeds: [
    // Add as many GitHub Atom release feeds as you like ↓
    "https://github.com/amir20/dozzle/releases.atom",
    "https://github.com/redimp/otterwiki/releases.atom",
    "https://github.com/immich-app/immich/releases.atom",
  ],
  outputDir: "summaries", // Subfolder to store per-feed summaries
  daysWindow: 60, // ← NEW: how many days back to look
};
