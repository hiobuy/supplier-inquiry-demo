// Server-only client for the local HIOBuy Gateway V2 adapter. The origin is fixed by
// server config; paths are built from validated identifiers only. Errors are sanitized.
export const USER_AGENT = "Inquiry-Demo/0.1";
const JSON_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PASS_STATUS = new Set([400, 401, 403, 404, 409, 410, 413, 415, 416, 422, 429]);

export class GatewayError extends Error {
  constructor(status, code, message, requestId = null) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function sanitizeMessage(message, secrets = []) {
  if (typeof message !== "string") return null;
  let m = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  for (const s of secrets) if (s && s.length >= 8) m = m.split(s).join("[redacted]");
  // Defensive: redact anything resembling a bearer credential.
  m = m.replace(/\b(sk|hb|hio|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]");
  return m.trim() || null;
}

async function readLimited(res, limit) {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > limit) throw new GatewayError(502, "GATEWAY_RESPONSE_TOO_LARGE", "Gateway response too large.");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new GatewayError(502, "GATEWAY_RESPONSE_TOO_LARGE", "Gateway response too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function assertUuid(id) { if (typeof id !== "string" || !UUID.test(id)) throw new GatewayError(400, "INVALID_ID", "Invalid identifier."); return id; }
export function assertId(id) { if (typeof id !== "string" || !ID.test(id)) throw new GatewayError(400, "INVALID_ID", "Invalid identifier."); return id; }

export class GatewayClient {
  constructor({ origin, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    this.origin = origin;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #raw(apiKey, method, path, { headers = {}, body, timeoutMs } = {}) {
    if (typeof apiKey !== "string" || !apiKey) throw new GatewayError(401, "KEY_REQUIRED", "Developer key required.");
    if (!path.startsWith("/v1/")) throw new Error("bad path");
    const h = { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT, ...headers };
    try {
      return await this.fetch(this.origin + path, {
        method, headers: h, body, redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        ...(body && typeof body.getReader === "function" ? { duplex: "half" } : {}),
      });
    } catch {
      throw new GatewayError(503, "GATEWAY_UNAVAILABLE", "HIOBuy Gateway is unavailable.");
    }
  }

  async #error(res, apiKey) {
    let parsed = null;
    try { parsed = JSON.parse(await readLimited(res, 64 * 1024)); } catch { /* ignore */ }
    const err = parsed && typeof parsed === "object" ? (parsed.error ?? parsed) : {};
    const rawCode = typeof err.code === "string" ? err.code : typeof err.error === "string" ? err.error : "";
    const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : null;
    const requestId = typeof parsed?.request_id === "string" ? parsed.request_id.slice(0, 128) : null;
    if (res.status >= 300 && res.status < 400) return new GatewayError(502, "GATEWAY_REDIRECT_REJECTED", "Unexpected redirect from Gateway.", requestId);
    if (PASS_STATUS.has(res.status)) {
      return new GatewayError(res.status, code ?? `HTTP_${res.status}`, sanitizeMessage(err.message, [apiKey]) ?? "Request rejected by Gateway.", requestId);
    }
    if (res.status === 503) return new GatewayError(503, code ?? "SERVICE_UNAVAILABLE", sanitizeMessage(err.message, [apiKey]) ?? "Service unavailable.", requestId);
    return new GatewayError(502, "GATEWAY_ERROR", "Gateway request failed.", requestId);
  }

  async json(apiKey, method, path, { body, idempotencyKey, timeoutMs } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await this.#raw(apiKey, method, path, { headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
    if (res.status < 200 || res.status >= 300) throw await this.#error(res, apiKey);
    const text = await readLimited(res, JSON_LIMIT);
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { throw new GatewayError(502, "GATEWAY_BAD_RESPONSE", "Gateway returned invalid JSON."); }
  }

  // ---- Typed operations ----
  identity(apiKey) { return this.json(apiKey, "GET", "/v1/ask/identity"); }
  productDetail(apiKey, { channel, id, language }) {
    return this.json(apiKey, "POST", "/v1/products/detail", { body: { channel, id, language }, timeoutMs: 30_000 });
  }
  createConversation(apiKey, body, idempotencyKey) { return this.json(apiKey, "POST", "/v1/ask/conversations", { body, idempotencyKey }); }
  conversation(apiKey, id) { return this.json(apiKey, "GET", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}`); }
  listMessages(apiKey, id, cursor) {
    const q = new URLSearchParams({ limit: "30" });
    if (cursor) q.set("cursor", cursor);
    return this.json(apiKey, "GET", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/messages?${q}`);
  }
  sendMessage(apiKey, id, body, idempotencyKey) {
    return this.json(apiKey, "POST", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/messages`, { body, idempotencyKey });
  }
  close(apiKey, id, idempotencyKey) { return this.json(apiKey, "POST", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/close`, { body: {}, idempotencyKey }); }
  ratingState(apiKey, id) { return this.json(apiKey, "GET", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/rating`); }
  rate(apiKey, id, body, idempotencyKey) { return this.json(apiKey, "POST", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/rating`, { body, idempotencyKey }); }

  async uploadAttachment(apiKey, id, { bytes, contentType, filename, idempotencyKey }) {
    const headers = { Accept: "application/json", "Content-Type": contentType, "Idempotency-Key": idempotencyKey };
    if (filename) headers["X-Image-Filename"] = filename;
    const res = await this.#raw(apiKey, "POST", `/v1/ask/conversations/${encodeURIComponent(assertId(id))}/attachments`, { headers, body: bytes, timeoutMs: 180_000 });
    if (res.status < 200 || res.status >= 300) throw await this.#error(res, apiKey);
    try { return { status: res.status, body: JSON.parse(await readLimited(res, 64 * 1024)) }; }
    catch { throw new GatewayError(502, "GATEWAY_BAD_RESPONSE", "Gateway returned invalid JSON."); }
  }

  /**
   * Returns the raw Response for streaming (caller validates headers). An authorized
   * 416 for a requested Range is returned (not thrown) so the caller can relay it with
   * its Content-Range; its body is discarded here.
   */
  async attachmentContent(apiKey, attachmentId, range) {
    const headers = {};
    if (range) headers.Range = range;
    const res = await this.#raw(apiKey, "GET", `/v1/ask/attachments/${assertUuid(attachmentId)}/content`, { headers, timeoutMs: 120_000 });
    if (res.status === 416 && range) { await res.body?.cancel().catch(() => {}); return res; }
    if (res.status !== 200 && res.status !== 206) throw await this.#error(res, apiKey);
    return res;
  }
}

/** Unwrap the documented optional {data: ...} envelope only when the root shape is absent. */
export function unwrap(body, rootKeys) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (rootKeys.some((k) => k in body)) return body;
    if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) return body.data;
  }
  return body;
}
