import { Database } from "bun:sqlite";
import { getDatabaseConfig } from "./config";

const RUN_LOCK_NAME = "invoice-delivery";
const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000;

export class InvoiceStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, {
      create: true,
      strict: true,
    });
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS processed_paths (path TEXT PRIMARY KEY NOT NULL);",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_locks (
        name TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    this.db
      .query("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)")
      .run("delivery_namespace", crypto.randomUUID());
  }

  hasBeenProcessed(path: string) {
    return this.db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM processed_paths WHERE path = ? LIMIT 1",
      )
      .get(path) !== null;
  }

  markBatchAsProcessed(paths: Iterable<string>) {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO processed_paths (path) VALUES (?)",
    );
    const transaction = this.db.transaction((batch: string[]) => {
      for (const path of batch) insert.run(path);
    });
    transaction.immediate(Array.from(paths));
  }

  acquireRunLock(
    owner: string,
    acquiredAt = Date.now(),
    ttlMs = DEFAULT_LOCK_TTL_MS,
  ) {
    const result = this.db
      .query(`
        INSERT INTO run_locks (name, owner, acquired_at)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner = excluded.owner,
          acquired_at = excluded.acquired_at
        WHERE run_locks.acquired_at <= excluded.acquired_at - ?
      `)
      .run(RUN_LOCK_NAME, owner, acquiredAt, ttlMs);

    return result.changes === 1;
  }

  releaseRunLock(owner: string) {
    this.db
      .query("DELETE FROM run_locks WHERE name = ? AND owner = ?")
      .run(RUN_LOCK_NAME, owner);
  }

  refreshRunLock(owner: string, refreshedAt = Date.now()) {
    const result = this.db
      .query("UPDATE run_locks SET acquired_at = ? WHERE name = ? AND owner = ?")
      .run(refreshedAt, RUN_LOCK_NAME, owner);
    return result.changes === 1;
  }

  getDeliveryNamespace() {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM metadata WHERE key = ?",
      )
      .get("delivery_namespace");
    if (!row) throw new Error("Delivery namespace is missing from SQLite");
    return row.value;
  }

  close() {
    this.db.close();
  }
}

let defaultStore: InvoiceStore | undefined;
const getDefaultStore = () => {
  defaultStore ??= new InvoiceStore(getDatabaseConfig().SQLITE_DB_PATH);
  return defaultStore;
};

export const hasBeenProcessed = (path: string) =>
  getDefaultStore().hasBeenProcessed(path);
export const markBatchAsProcessed = (paths: Iterable<string>) =>
  getDefaultStore().markBatchAsProcessed(paths);
export const acquireRunLock = (owner: string) =>
  getDefaultStore().acquireRunLock(
    owner,
    Date.now(),
    getDatabaseConfig().RUN_LOCK_TTL_SECONDS * 1000,
  );
export const releaseRunLock = (owner: string) =>
  getDefaultStore().releaseRunLock(owner);
export const refreshRunLock = (owner: string) =>
  getDefaultStore().refreshRunLock(owner);
export const getDeliveryNamespace = () =>
  getDefaultStore().getDeliveryNamespace();
