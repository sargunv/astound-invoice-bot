import { parseConfig, parseDatabaseConfig } from "./config-schema";

let cachedConfig: ReturnType<typeof parseConfig> | undefined;
let cachedDatabaseConfig: ReturnType<typeof parseDatabaseConfig> | undefined;

export const getConfig = () => {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
};

export const getDatabaseConfig = () => {
  cachedDatabaseConfig ??= parseDatabaseConfig(process.env);
  return cachedDatabaseConfig;
};
