import { Database } from "bun:sqlite";
import { config } from "./config";

const db = new Database(config.SQLITE_DB_PATH, {
  create: true,
  strict: true,
});

db.query(
  "CREATE TABLE IF NOT EXISTS processed_paths (path STRING PRIMARY KEY);"
).run();

export const hasBeenProcessed = (path: string) => {
  const count = db
    .query("SELECT COUNT(*) as count FROM processed_paths WHERE path = ?")
    .get(path) as { count: number };

  return count.count > 0;
};

export const markAsProcessed = (path: string) => {
  db.query("INSERT INTO processed_paths (path) VALUES (?)").run(path);
};
