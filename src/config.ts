import { parseConfig } from "./config-schema";

let cachedConfig: ReturnType<typeof parseConfig> | undefined;

export const getConfig = () => {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
};
