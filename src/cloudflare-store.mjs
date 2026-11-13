import { SqlStore } from "./sql-store.mjs";

/** The shared SQLite store on Cloudflare's private, transactional Durable Object SQL. */
export class CloudflareStore extends SqlStore {
  constructor(storage) {
    const sql = storage.sql;
    const db = {
      exec(query) { sql.exec(query).toArray(); },
      prepare(query) {
        return {
          get(...args) { return sql.exec(query, ...args).toArray()[0]; },
          all(...args) { return sql.exec(query, ...args).toArray(); },
          run(...args) {
            sql.exec(query, ...args).toArray();
            return sql.exec("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid").one();
          },
        };
      },
    };
    super(db, { transaction: (fn) => storage.transactionSync(fn) });
    db.exec("CREATE TABLE IF NOT EXISTS demo_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  }
  limit(key, maximum, periodMs) {
    const now = Date.now(), window = Math.floor(now / periodMs), expires = (window + 1) * periodMs;
    const id = `${key}:${window}`;
    const row = this.db.prepare(`INSERT INTO demo_limits(key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).get(id, expires);
    if (row.count > maximum) return Math.max(1, Math.ceil((expires - now) / 1000));
    return 0;
  }
}
