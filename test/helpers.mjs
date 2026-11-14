// Unit-test fixtures only. The fake Gateway is injected server-side via createDemoServer({fetchImpl});
// nothing here is reachable from a browser request and it is not a runtime mode.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDemoServer } from "../src/server.mjs";
import { validateConfig } from "../src/config.mjs";

export const KEY_A = "test-key-app-a-0123456789abcdef";
export const KEY_A2 = "test-key-app-a-second-0123456789";
export const KEY_B = "test-key-app-b-0123456789abcdef";
export const KEY_NOSCOPE = "test-key-noscope-0123456789abcd";
// Test-only webhook verification secrets (>= 32 printable chars), written to private tmp fixtures.
export const SECRET_A = "test_whsec_app_a_0123456789abcdef0123";
export const SECRET_B = "test_whsec_app_b_0123456789abcdef0123";
export const SAMPLE_ID = "673124809943";
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Write a private (mode 600 by default) webhook verification fixture; returns its absolute path. */
export function writeWebhookConfig(content = { apps: { app_a: { signingSecret: SECRET_A }, app_b: { signingSecret: SECRET_B } } }, mode = 0o600) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inquiry-demo-wh-"));
  const file = path.join(dir, "webhook-config.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  chmodSync(file, mode);
  return file;
}

/** In-memory fake Gateway V2 adapter. Records every call (method, path, headers, body). */
export function fakeGateway() {
  const g = {
    calls: [], down: false, failNextCreate: false, failNextSend: false,
    conversations: new Map(), // remoteId -> {app, ext, status, messages:[]}
    idem: new Map(), // `${app}|${key}` -> response body
    attachments: new Map(), // id -> {app, bytes, type}
    ratings: new Map(),
    seq: 0,
  };
  const appFor = (auth) => ({ [`Bearer ${KEY_A}`]: "app_a", [`Bearer ${KEY_A2}`]: "app_a", [`Bearer ${KEY_B}`]: "app_b", [`Bearer ${KEY_NOSCOPE}`]: "app_n" })[auth] ?? null;
  const NAMES = { app_a: "App A", app_b: "App B", app_n: "App N" };
  g.addStaffMessage = (remoteId, content, extra = {}) => {
    const c = g.conversations.get(remoteId);
    const m = { id: `msg_staff_${++g.seq}`, conversation_id: remoteId, client_message_id: `reply_${g.seq}`, type: "text", content,
      language: "en", status: "accepted", translation_status: "manual", created_at: new Date(Date.UTC(2026, 10, 13, 12, 0, g.seq)).toISOString(), sender_type: "staff", attachments: [], ...extra };
    c.messages.push(m);
    return m;
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep */ } }
    g.calls.push({ method: init.method, path: u.pathname + u.search, headers, body, redirect: init.redirect });
    if (g.down) throw new TypeError("fetch failed");
    const auth = headers.authorization;
    const app = appFor(auth);
    const scoped = app && app !== "app_n";
    if (u.pathname === "/v1/ask/identity") {
      if (!app) return json(401, { error: { code: "INVALID_API_KEY", message: `Invalid key ${auth?.slice(7)}` } });
      // Revised Gateway identity: verification succeeds without inquiry scopes; flags report state.
      return json(200, { data: { app: { id: app, name: NAMES[app] },
        api_key: { scopes: scoped ? ["products:read", "supplier_inquiry:read", "supplier_inquiry:write"] : ["products:read"] },
        inquiry: { enabled: scoped, mapped: scoped, read: scoped, write: scoped, webhook_configured: scoped },
        adapter: { name: "hioask-v2-local" } }, request_id: "req_identity" });
    }
    if (!app) return json(401, { error: { code: "INVALID_API_KEY", message: "Invalid key." } });
    if (u.pathname === "/v1/products/detail") {
      return json(200, { product: { id: body.id, title: { original: "原标题", translated: `Product ${body.id}` },
        images: [{ url: "https://cbu01.alicdn.com/img/ibank/a.jpg" }, { url: "https://global-img-cdn.1688.com/img/ibank/O1CN01test.jpg?x=1" },
          { url: "https://evil.example.com/x.jpg" }, { url: "https://img.1688.com/x.jpg" }, { url: "https://global-img-cdn.1688.com.evil.com/x.jpg" }, "javascript:alert(1)"],
        price: { original_amount: 12.5, original_currency: "CNY" }, seller: { name: "Seller" }, variants: [{ name: "Red" }, { name: "Blue" }],
        source_url: "https://evil.example.com/" }, request_id: "req_detail" });
    }
    if (u.pathname.startsWith("/v1/ask/") && !scoped) return json(403, { error: { code: "INSUFFICIENT_SCOPE", message: "Missing supplier_inquiry scope." } });
    const idemKey = headers["idempotency-key"];
    const replay = (fn, status = 201) => {
      const k = `${app}|${u.pathname}|${idemKey}`;
      if (g.idem.has(k)) return json(200, g.idem.get(k));
      const r = fn(); g.idem.set(k, r); return json(status, r);
    };
    if (u.pathname === "/v1/ask/conversations" && init.method === "POST") {
      if (g.failNextCreate) { g.failNextCreate = false; return json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "HIOAsk unavailable." } }); }
      return replay(() => {
        const id = `conv_${++g.seq}`;
        g.conversations.set(id, { app, ext: body.external_conversation_id, status: "pending", messages: [], context: body.context });
        return { data: { id, external_conversation_id: body.external_conversation_id, status: "pending", context: body.context } };
      });
    }
    let m = /^\/v1\/ask\/conversations\/([^/]+)(?:\/(messages|attachments|close|rating))?$/.exec(u.pathname);
    if (m) {
      const c = g.conversations.get(m[1]);
      if (!c || c.app !== app) return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
      if (!m[2]) return json(200, { data: { id: m[1], status: c.status } });
      if (m[2] === "messages" && init.method === "GET") return json(200, { data: [...c.messages].reverse(), pagination: { next_cursor: null } });
      if (m[2] === "messages") {
        if (g.failNextSend) { g.failNextSend = false; return json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "busy" } }); }
        return replay(() => {
          const msg = { id: `msg_${++g.seq}`, conversation_id: m[1], client_message_id: body.client_message_id, type: body.type, content: body.content ?? "",
            language: null, status: "accepted", translation_status: "pending", created_at: new Date(Date.UTC(2026, 10, 13, 11, 0, g.seq)).toISOString(), sender_type: "customer",
            attachments: (body.attachment_ids ?? []).map((id) => ({ id, filename: "a.png", content_type: g.attachments.get(id).type, size: 72, width: 1, height: 1, content_path: `/v1/ask/attachments/${id}/content` })),
            ...(body.product_card ? { product_card: body.product_card } : {}) };
          c.messages.push(msg);
          return { data: msg };
        });
      }
      if (m[2] === "attachments") {
        const bytes = Buffer.from(body);
        return replay(() => {
          const id = randomUUID();
          g.attachments.set(id, { app, bytes, type: headers["content-type"] });
          return { data: { id, filename: "a.png", content_type: headers["content-type"], size: bytes.length, width: 1, height: 1, content_path: `/v1/ask/attachments/${id}/content` } };
        });
      }
      if (m[2] === "close") return replay(() => { c.status = "closed"; return { data: { id: m[1], status: "closed" } }; }, 200);
      if (m[2] === "rating" && init.method === "GET") return json(200, { data: { status: c.status === "closed" ? (g.ratings.has(m[1]) ? "submitted" : "available") : "not_closed", eligible_until: "2026-11-20T00:00:00Z", rating: g.ratings.get(m[1]) ?? null } });
      if (m[2] === "rating") return replay(() => { const r = { id: "rat_1", conversation_id: m[1], ...body, created_at: "2026-11-13T00:00:00Z" }; g.ratings.set(m[1], r); return { data: r }; });
    }
    m = /^\/v1\/ask\/attachments\/([^/]+)\/content$/.exec(u.pathname);
    if (m) {
      const a = g.attachments.get(m[1]);
      if (!a || a.app !== app) return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
      const range = headers.range;
      if (range) {
        const size = a.bytes.length;
        const r = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start; let end;
        if (r && r[1] === "" && r[2] !== "") { const n = Number(r[2]); start = Math.max(0, size - n); end = size - 1; if (n === 0) start = size; }
        else if (r && r[1] !== "") { start = Number(r[1]); end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1; }
        if (!r || start === undefined || start >= size || end < start) {
          return new Response(JSON.stringify({ error: { code: "RANGE_NOT_SATISFIABLE", message: "x" } }), { status: 416, headers: { "content-type": "application/json", "content-range": `bytes */${size}` } });
        }
        return new Response(a.bytes.subarray(start, end + 1), { status: 206, headers: { "content-type": a.type, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${a.bytes.length}` } });
      }
      return new Response(a.bytes, { status: 200, headers: { "content-type": a.type, "content-length": String(a.bytes.length) } });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
  };
  return g;
}

/**
 * Real local HTTP Gateway fixture: serves the fake Gateway's responses over an actual
 * loopback socket so the Demo uses its real fetch path (headers, status, streaming).
 */
export async function startHttpGateway(g = fakeGateway()) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const isJson = /^application\/json/i.test(req.headers["content-type"] ?? "");
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    try {
      const r = await g.fetch(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: buf.length ? (isJson ? buf.toString("utf8") : buf) : undefined });
      const out = Buffer.from(await r.arrayBuffer());
      const h = {};
      r.headers.forEach((v, k) => { h[k] = v; });
      h["content-length"] = String(out.length);
      res.writeHead(r.status, h);
      res.end(out);
    } catch { res.destroy(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { gateway: g, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/**
 * Start the Demo. webhookConfigFile: undefined -> fresh private fixture with App A/B secrets;
 * null -> no webhook verification configured; string -> that file.
 */
export async function startDemo({ gateway = fakeGateway(), dataDir = mkdtempSync(path.join(os.tmpdir(), "inquiry-demo-")), clock = { t: Date.UTC(2026, 10, 13, 12) },
  demoDefaults=null, webhookConfigFile, gatewayOrigin = "http://127.0.0.1:18802", fetchImpl, mediaEnabled, videosEnabled } = {}) {
  const wf = webhookConfigFile === undefined ? writeWebhookConfig() : webhookConfigFile;
  const config = { ...validateConfig({ gatewayOrigin, dataDir, port: 0, webhookConfigFile: wf }) };
  if (mediaEnabled !== undefined) config.mediaEnabled = mediaEnabled;
  if (videosEnabled !== undefined) config.videosEnabled = videosEnabled;
  const app = createDemoServer({ config, fetchImpl: fetchImpl ?? gateway.fetch, now: () => clock.t, demoDefaults });
  const port = await app.start();
  return { app, port, gateway, dataDir, clock, webhookConfigFile: wf };
}

export function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `localhost:${port}`, ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString("utf8")); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Simulated same-origin browser with its own cookie jar. */
export class Browser {
  constructor(port, cookie = null) { this.port = port; this.cookie = cookie; this.csrf = null; }
  async init() {
    const r = await this.call("GET", "/api/session");
    const sc = r.headers["set-cookie"]?.[0];
    if (sc) this.cookie = sc.split(";")[0];
    this.csrf = r.json.csrf_token;
    return r;
  }
  call(method, p, body, extra = {}) {
    const headers = { cookie: this.cookie ?? undefined };
    if (method !== "GET" && method !== "HEAD") { headers.origin = `http://localhost:${this.port}`; headers["x-csrf-token"] = this.csrf; }
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    Object.assign(headers, extra);
    if (payload !== undefined && headers["content-length"] === undefined) headers["content-length"] = String(Buffer.byteLength(payload));
    return request(this.port, { method, path: p, headers, body: payload });
  }
  async login(key) { return this.call("POST", "/api/key", { api_key: key }); }
}

/** Login + lookup + Contact Supplier. Returns conversation view. */
export async function openInquiry(b, id = SAMPLE_ID) {
  await b.call("POST", "/api/products/lookup", { channel: "1688", value: id });
  const r = await b.call("POST", "/api/conversations", { slot: `1688:${id}` });
  return r.json.conversation;
}
