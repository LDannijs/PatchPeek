import fs from "fs/promises";
import path from "path";

const configFile = path.resolve("./data/config.json");
const defaultConfig = { feeds: [], daysWindow: 31, githubToken: "" };

export const readConfig = async () => {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  try {
    return JSON.parse(await fs.readFile(configFile, "utf-8"));
  } catch {
    await fs.writeFile(configFile, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
};

export const saveConfig = async (config) =>
  fs.writeFile(configFile, JSON.stringify(config, null, 2));

export const updateConfigField = async (field, value) => {
  if (typeof field !== "string") return;
  const config = await readConfig();
  config[field] = value;
  await saveConfig(config);
};

export const loadConfigAndCutoff = async () => {
  const config = await readConfig();
  return { ...config, cutoff: Date.now() - config.daysWindow * 86400000 };
};
