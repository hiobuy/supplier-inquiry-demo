// Memory-only developer API key vault. Hard TTL from validation time; never extended,
// never persisted, never serialized. Keys are indexed by hashed session ID.
export const KEY_TTL_MS = 60 * 60 * 1000;

export class KeyVault {
  #entries = new Map();
  #now;
  #timer = null;

  constructor({ now = () => Date.now(), ttlMs = KEY_TTL_MS } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > KEY_TTL_MS) throw new Error("Invalid key TTL");
    this.#now = now;
    this.ttlMs = ttlMs;
  }

  set(sessionHash, apiKey, appId) {
    const expiresAt = this.#now() + this.ttlMs;
    this.#entries.set(sessionHash, Object.freeze({ apiKey, appId, expiresAt }));
    return expiresAt;
  }

  /** Returns {apiKey, appId, expiresAt} or null; expired entries are dropped. */
  get(sessionHash) {
    const e = this.#entries.get(sessionHash);
    if (!e) return null;
    if (this.#now() >= e.expiresAt) { this.#entries.delete(sessionHash); return null; }
    return e;
  }

  delete(sessionHash) { this.#entries.delete(sessionHash); }

  /** Any live key verified for this App (used only for server-side reconciliation). */
  anyForApp(appId) {
    for (const [h, e] of this.#entries) if (e.appId === appId && this.get(h)) return e;
    return null;
  }

  purge() {
    const t = this.#now();
    for (const [h, e] of this.#entries) if (t >= e.expiresAt) this.#entries.delete(h);
  }

  get size() { return this.#entries.size; }

  startPurge(intervalMs = 30_000) {
    this.stopPurge();
    this.#timer = setInterval(() => this.purge(), intervalMs);
    this.#timer.unref?.();
  }

  stopPurge() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  clear() { this.#entries.clear(); }

  // Prevent accidental serialization/inspection of secrets.
  toJSON() { return { entries: this.#entries.size }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return `KeyVault(${this.#entries.size})`; }
}
