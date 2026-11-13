// Shared synchronous SQLite operations. Credentials/signing secrets never enter storage.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, app_id TEXT, user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT PRIMARY KEY, name TEXT, first_verified_at INTEGER NOT NULL, last_verified_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  app_id TEXT NOT NULL, slot TEXT NOT NULL, data_json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, slot));
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, user_id TEXT NOT NULL, slot TEXT NOT NULL,
  generation INTEGER NOT NULL, external_id TEXT NOT NULL UNIQUE, hioask_id TEXT UNIQUE,
  title TEXT NOT NULL, product_url TEXT NOT NULL, product_id TEXT NOT NULL, channel TEXT NOT NULL,
  price_label TEXT, status TEXT NOT NULL DEFAULT 'creating', card_cmid TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (app_id, user_id, slot, generation));
CREATE TABLE IF NOT EXISTS outbound (
  conversation_id INTEGER NOT NULL, client_message_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  message_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, client_message_id));
CREATE TABLE IF NOT EXISTS uploads (
  conversation_id INTEGER NOT NULL, upload_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  attachment_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, upload_id));
CREATE TABLE IF NOT EXISTS media (
  conversation_id INTEGER NOT NULL, attachment_id TEXT NOT NULL, content_type TEXT NOT NULL,
  PRIMARY KEY (conversation_id, attachment_id));
CREATE TABLE IF NOT EXISTS messages (
  conversation_id INTEGER NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL,
  sender_type TEXT NOT NULL, dto_json TEXT NOT NULL, webhook_at INTEGER, api_at INTEGER,
  changed_seq INTEGER NOT NULL, PRIMARY KEY (conversation_id, message_id));
CREATE INDEX IF NOT EXISTS messages_seq ON messages (conversation_id, changed_seq);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, app_id TEXT NOT NULL, type TEXT NOT NULL,
  conversation_id INTEGER, outcome TEXT NOT NULL, received_at INTEGER NOT NULL);
`;

export class SqlStore {
  constructor(db, { now = () => Date.now(), transaction = null } = {}) {
    this.db = db; this.now = now; this.transaction = transaction;
    this.db.exec(SCHEMA);
  }
  tx(fn) {
    if (this.transaction) return this.transaction(fn);
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  nextSeq() {
    this.db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'").run();
    return this.db.prepare("SELECT v FROM meta WHERE k = 'seq'").get().v;
  }
  // ---- sessions ----
  createSession({ idHash, csrf, userId, ttlMs }) {
    const t = this.now();
    this.db.prepare("INSERT INTO sessions (id_hash, csrf, app_id, user_id, created_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(idHash, csrf, userId, t, t + ttlMs);
  }
  getSession(idHash) {
    const s = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash);
    if (!s) return null;
    if (s.expires_at <= this.now()) { this.deleteSession(idHash); return null; }
    return s;
  }
  bindSessionApp(idHash, appId) {
    // Only binds an unbound session; never rebinds to another App.
    const r = this.db.prepare("UPDATE sessions SET app_id = ? WHERE id_hash = ? AND app_id IS NULL").run(appId, idHash);
    return r.changes === 1;
  }
  deleteSession(idHash) { this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash); }
  purgeSessions() { this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now()); }

  upsertApp(appId, name) {
    const t = this.now();
    this.db.prepare(`INSERT INTO apps (app_id, name, first_verified_at, last_verified_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, last_verified_at = excluded.last_verified_at`).run(appId, name, t, t);
  }

  // ---- products ----
  saveProduct(appId, product) {
    this.db.prepare(`INSERT INTO products (app_id, slot, data_json, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(app_id, slot) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`)
      .run(appId, product.slot, JSON.stringify(product), this.now());
  }
  getProduct(appId, slot) {
    const r = this.db.prepare("SELECT data_json FROM products WHERE app_id = ? AND slot = ?").get(appId, slot);
    return r ? JSON.parse(r.data_json) : null;
  }

  // ---- conversations ----
  latestConversation(appId, userId, slot) {
    return this.db.prepare("SELECT * FROM conversations WHERE app_id = ? AND user_id = ? AND slot = ? ORDER BY generation DESC LIMIT 1")
      .get(appId, userId, slot) ?? null;
  }
  insertConversation(row) {
    const t = this.now();
    this.db.prepare(`INSERT INTO conversations (app_id, user_id, slot, generation, external_id, title, product_url, product_id, channel, price_label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`).run(row.appId, row.userId, row.slot, row.generation, row.externalId,
      row.title, row.productUrl, row.productId, row.channel, row.priceLabel ?? null, t, t);
    return this.db.prepare("SELECT * FROM conversations WHERE external_id = ?").get(row.externalId);
  }
  setConversationRemote(id, hioaskId, status) {
    this.db.prepare("UPDATE conversations SET hioask_id = COALESCE(hioask_id, ?), status = ?, updated_at = ? WHERE id = ?").run(hioaskId, status, this.now(), id);
  }
  setConversationStatus(id, status) { this.db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), id); }
  /** Owned lookup: conversation must belong to this App + user. */
  ownedConversation(id, appId, userId) {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ? AND app_id = ? AND user_id = ?").get(id, appId, userId) ?? null;
  }
  conversationByRemote(hioaskId) { return this.db.prepare("SELECT * FROM conversations WHERE hioask_id = ?").get(hioaskId) ?? null; }
  listConversations(appId, userId) {
    return this.db.prepare("SELECT * FROM conversations WHERE app_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100").all(appId, userId);
  }
  claimCard(id, cmid) {
    return this.db.prepare("UPDATE conversations SET card_cmid = ? WHERE id = ? AND card_cmid IS NULL").run(cmid, id).changes === 1;
  }

  // ---- outbound customer messages ----
  getOutbound(convId, cmid) { return this.db.prepare("SELECT * FROM outbound WHERE conversation_id = ? AND client_message_id = ?").get(convId, cmid) ?? null; }
  insertOutbound(convId, cmid, payload) {
    this.db.prepare("INSERT INTO outbound (conversation_id, client_message_id, payload_json, created_at) VALUES (?, ?, ?, ?)").run(convId, cmid, JSON.stringify(payload), this.now());
  }
  setOutboundMessage(convId, cmid, messageId) {
    this.db.prepare("UPDATE outbound SET message_id = ? WHERE conversation_id = ? AND client_message_id = ?").run(messageId, convId, cmid);
  }

  // ---- uploads/media ----
  getUpload(convId, uploadId) { return this.db.prepare("SELECT * FROM uploads WHERE conversation_id = ? AND upload_id = ?").get(convId, uploadId) ?? null; }
  insertUpload(convId, uploadId, fingerprint) {
    this.db.prepare("INSERT OR IGNORE INTO uploads (conversation_id, upload_id, fingerprint, created_at) VALUES (?, ?, ?, ?)").run(convId, uploadId, fingerprint, this.now());
  }
  completeUpload(convId, uploadId, attachment) {
    this.db.prepare("UPDATE uploads SET attachment_json = ? WHERE conversation_id = ? AND upload_id = ?").run(JSON.stringify(attachment), convId, uploadId);
    this.addMedia(convId, attachment.id, attachment.content_type);
  }
  /** Attachments uploaded by THIS conversation's owner and not yet sent. */
  uploadedAttachmentIds(convId) {
    return new Set(this.db.prepare("SELECT attachment_json FROM uploads WHERE conversation_id = ? AND attachment_json IS NOT NULL").all(convId)
      .map((r) => JSON.parse(r.attachment_json).id));
  }
  addMedia(convId, attachmentId, contentType) {
    this.db.prepare("INSERT OR IGNORE INTO media (conversation_id, attachment_id, content_type) VALUES (?, ?, ?)").run(convId, attachmentId, contentType);
  }
  getMedia(convId, attachmentId) { return this.db.prepare("SELECT * FROM media WHERE conversation_id = ? AND attachment_id = ?").get(convId, attachmentId) ?? null; }

  // ---- messages (reconciled cache) ----
  /** Upsert a sanitized message. source: 'webhook' | 'api'. Returns true if changed. */
  upsertMessage(convId, dto, source) {
    const t = this.now();
    const existing = this.db.prepare("SELECT webhook_at, api_at, dto_json FROM messages WHERE conversation_id = ? AND message_id = ?").get(convId, dto.id);
    const json = JSON.stringify(dto);
    if (!existing) {
      this.db.prepare(`INSERT INTO messages (conversation_id, message_id, created_at, sender_type, dto_json, webhook_at, api_at, changed_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(convId, dto.id, dto.created_at, dto.sender_type, json,
        source === "webhook" ? t : null, source === "api" ? t : null, this.nextSeq());
      return true;
    }
    const col = source === "webhook" ? "webhook_at" : "api_at";
    if (existing[col] !== null && existing.dto_json === json) return false;
    this.db.prepare(`UPDATE messages SET dto_json = ?, ${col} = COALESCE(${col}, ?), changed_seq = ? WHERE conversation_id = ? AND message_id = ?`)
      .run(json, t, this.nextSeq(), convId, dto.id);
    return true;
  }
  messagesSince(convId, since, limit = 100) {
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND changed_seq > ? ORDER BY changed_seq ASC LIMIT ?").all(convId, since, limit);
  }
  messageRows(convId, ids) {
    if (!ids.length) return [];
    const q = `SELECT * FROM messages WHERE conversation_id = ? AND message_id IN (${ids.map(() => "?").join(",")})`;
    return this.db.prepare(q).all(convId, ...ids);
  }
  currentSeq() { return this.db.prepare("SELECT v FROM meta WHERE k = 'seq'").get().v; }

  // ---- webhook events ----
  getEvent(eventId) { return this.db.prepare("SELECT * FROM webhook_events WHERE event_id = ?").get(eventId) ?? null; }
  insertEvent(e) {
    this.db.prepare("INSERT INTO webhook_events (event_id, body_hash, app_id, type, conversation_id, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.eventId, e.bodyHash, e.appId, e.type, e.conversationId ?? null, e.outcome, this.now());
  }
}
