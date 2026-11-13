// Local Node SQLite adapter. Production uses the same store operations on Durable Objects.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { SqlStore } from "./sql-store.mjs";

export class Store extends SqlStore {
  constructor(dataDir, { now = () => Date.now() } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "inquiry-demo.sqlite");
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    super(db, { now });
    this.file = file;
    chmodSync(file, 0o600);
  }
  close() { try { this.db.close(); } catch {} }
}
