// Inquiry Demo backend. Browser -> this server -> local HIOBuy Gateway V2 adapter.
// Developer keys live only in the memory KeyVault. No request can choose the upstream,
// App, Demo user or conversation ownership.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { KeyVault, KEY_TTL_MS } from "./keyvault.mjs";
import { GatewayClient, GatewayError, unwrap } from "./gateway.mjs";
import {
  parseProductInput,
  normalizeProduct,
  ProductInputError,
  cardTitle,
} from "./product.mjs";
import { verifySignature, parseEvent } from "./webhook.mjs";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = "inq_sid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PRINTABLE_SECRET = /^[!-~]{16,512}$/;
const CURSOR = /^[A-Za-z0-9._~=:+\/-]{1,512}$/;
const STATUSES = new Set([
  "pending",
  "processing",
  "waiting_supplier",
  "waiting_customer",
  "closed",
]);
const MEDIA_TYPES = {
  "image/png": 10 * 1024 * 1024,
  "image/jpeg": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "video/mp4": 20 * 1024 * 1024,
};
const EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};
const PRODUCT_URL = [
  /^https:\/\/detail\.1688\.com\/offer\/[0-9]{1,20}\.html$/,
  /^https:\/\/item\.taobao\.com\/item\.htm\?id=[0-9]{1,20}(&skuId=[0-9]{1,20})?$/,
  /^https:\/\/detail\.tmall\.com\/item\.htm\?id=[0-9]{1,20}(&skuId=[0-9]{1,20})?$/,
];
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.alicdn.com https://global-img-cdn.1688.com; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const cpLen = (s) => [...s].length;
function plain(v, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return cpLen(s) > max ? [...s].slice(0, max).join("") : s;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sanitizeAttachment(a, convId) {
  const o = obj(a);
  if (
    !o ||
    typeof o.id !== "string" ||
    !UUID.test(o.id) ||
    !(o.content_type in MEDIA_TYPES)
  )
    return null;
  const int = (v) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null);
  const out = {
    id: o.id.toLowerCase(),
    filename: plain(o.filename, 128) || `attachment.${EXT[o.content_type]}`,
    content_type: o.content_type,
    size: int(o.size),
    width: int(o.width),
    height: int(o.height),
    content_path: `/api/conversations/${convId}/attachments/${o.id.toLowerCase()}/content`,
  };
  if (int(o.duration_ms) !== null) out.duration_ms = o.duration_ms;
  return out;
}

export function sanitizeMessage(m, convId) {
  const o = obj(m);
  if (!o || typeof o.id !== "string" || !ID.test(o.id)) return null;
  if (o.sender_type !== "customer" && o.sender_type !== "staff") return null;
  const recalled = o.recalled_at !== undefined;
  if (recalled && (o.sender_type !== "staff" || !validRecallTime(o.recalled_at))) return null;
  const out = {
    id: o.id,
    conversation_id:
      typeof o.conversation_id === "string" ? o.conversation_id : null,
    client_message_id: plain(o.client_message_id, 128),
    type: o.type === "image" ? "image" : "text",
    content: plain(o.content, 10000) ?? "",
    sender_type: o.sender_type,
    created_at:
      typeof o.created_at === "string"
        ? o.created_at.slice(0, 40)
        : new Date(0).toISOString(),
    attachments: Array.isArray(o.attachments)
      ? o.attachments
          .slice(0, 4)
          .map((a) => sanitizeAttachment(a, convId))
          .filter(Boolean)
      : [],
  };
  const card = obj(o.product_card);
  if (
    card &&
    typeof card.url === "string" &&
    PRODUCT_URL.some((r) => r.test(card.url)) &&
    plain(card.title, 200)
  ) {
    out.product_card = {
      url: card.url,
      title: plain(card.title, 200),
      price_label: plain(card.price_label, 64) || null,
    };
  }
  if (recalled) {
    out.recalled_at = o.recalled_at;
    out.type = "text";
    out.content = "";
    out.attachments = [];
    delete out.product_card;
  }
  return out;
}

function validRecallTime(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function conversationView(c) {
  return {
    id: c.id,
    title: c.title,
    product_url: c.product_url,
    product_id: c.product_id,
    channel: c.channel,
    price_label: c.price_label,
    generation: c.generation,
    status: c.status,
    ready: !!c.hioask_id,
    source: "Inquiry Demo",
    created_at: new Date(c.created_at).toISOString(),
    updated_at: new Date(c.updated_at).toISOString(),
  };
}

function messageView(row) {
  const dto = JSON.parse(row.dto_json);
  const webhook = row.webhook_at;
  const api = row.api_at;
  let arrival = null;
  if (dto.sender_type === "staff")
    arrival =
      webhook !== null && (api === null || webhook <= api)
        ? "webhook"
        : "recovered";
  return {
    ...dto,
    arrival,
    webhook_confirmed: webhook !== null,
    seq: row.changed_seq,
  };
}

export function createDemoHandler({
  config,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  keyTtlMs = KEY_TTL_MS,
  store,
  assets = new Map(),
  webhookSecrets = new Map(),
  demoDefaults = null,
}) {
  if (!store) throw new Error("A persistent metadata store is required");
  const cookieName = config.publicOrigin ? "__Host-inq_sid" : COOKIE;
  const secureCookie = config.publicOrigin ? "; Secure" : "";
  const vault = new KeyVault({ now, ttlMs: keyTtlMs });
  const gateway = new GatewayClient({
    origin: config.gatewayOrigin,
    fetchImpl,
  });
  const inquiryState = new Map(); // session hash -> sanitized identity inquiry flags (memory only)
  const locks = new Map();
  const productCache = new Map();
  let allowedHosts = new Set(config.publicOrigin ? [new URL(config.publicOrigin).host] : []);

  function serialize(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  // ---------- helpers ----------
  function baseHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CSP);
  }
  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }
  function sendError(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError || err instanceof GatewayError) {
      return sendJson(res, err.status, {
        error: {
          code: err.code,
          message: err.message,
          ...(err.requestId ? { request_id: err.requestId } : {}),
        },
      });
    }
    if (err instanceof ProductInputError)
      return sendJson(res, 400, {
        error: { code: err.code, message: err.message },
      });
    sendJson(res, 500, {
      error: { code: "INTERNAL_ERROR", message: "Internal error." },
    });
  }
  async function readBody(req, limit) {
    const len = req.headers["content-length"];
    if (
      len !== undefined &&
      (!/^[0-9]{1,10}$/.test(len) || Number(len) > limit)
    )
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body too large.");
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > limit)
        throw new HttpError(413, "BODY_TOO_LARGE", "Request body too large.");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req, allowed, limit = 16 * 1024) {
    if (
      !/^application\/json(;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] ?? "",
      )
    )
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "JSON required.");
    let body;
    try {
      body = JSON.parse((await readBody(req, limit)).toString("utf8"));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "INVALID_JSON", "Invalid JSON.");
    }
    if (!obj(body))
      throw new HttpError(400, "INVALID_BODY", "JSON object required.");
    for (const k of Object.keys(body))
      if (!allowed.includes(k))
        throw new HttpError(
          400,
          "UNKNOWN_FIELD",
          `Unsupported field: ${k.slice(0, 40)}`,
        );
    return body;
  }
  function parseCookie(req) {
    const raw = req.headers.cookie;
    if (typeof raw !== "string" || raw.length > 4096) return null;
    for (const part of raw.split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === cookieName && /^[A-Za-z0-9_-]{43}$/.test(v ?? "")) return v;
    }
    return null;
  }
  function newSession(res) {
    const sid = randomBytes(32).toString("base64url");
    const idHash = sha256(sid);
    store.createSession({
      idHash,
      csrf: randomBytes(32).toString("base64url"),
      userId: `demo_${randomBytes(12).toString("hex")}`,
      ttlMs: SESSION_TTL_MS,
    });
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${sid}; HttpOnly; SameSite=Strict${secureCookie}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    return store.getSession(idHash);
  }
  function requireKey(sess) {
    const entry = vault.get(sess.id_hash);
    if (!entry || !sess.app_id)
      throw new HttpError(
        401,
        "KEY_REQUIRED",
        "Enter your HIOBuy developer key to continue.",
      );
    if (entry.appId !== sess.app_id) {
      vault.delete(sess.id_hash);
      throw new HttpError(
        403,
        "APP_MISMATCH",
        "Key does not match this session's App.",
      );
    }
    return entry.apiKey;
  }
  function owned(sess, idStr) {
    if (!/^[0-9]{1,12}$/.test(idStr))
      throw new HttpError(404, "NOT_FOUND", "Conversation not found.");
    const c = store.ownedConversation(Number(idStr), sess.app_id, sess.user_id);
    if (!c || (demoDefaults && c.slot !== demoDefaults.product.slot))
      throw new HttpError(404, "NOT_FOUND", "Conversation not found.");
    return c;
  }
  function requireRemote(c) {
    if (!c.hioask_id)
      throw new HttpError(
        409,
        "CONVERSATION_NOT_READY",
        "Conversation is not created yet; use Contact Supplier again.",
      );
    return c.hioask_id;
  }
  // Sanitized local verification state only: whether HIOBuy admin provisioned this App's
  // developer-webhook secret to this Demo. Never the secret; never another App's state.
  function webhookView(appId) {
    return {
      status:
        appId && webhookSecrets.has(appId) ? "configured" : "not_configured",
      managed_by: "hiobuy",
    };
  }
  function inquiryFlags(ident) {
    const q = obj(ident?.inquiry);
    if (!q) return null;
    const out = {};
    for (const k of [
      "enabled",
      "mapped",
      "read",
      "write",
      "webhook_configured",
    ])
      out[k] = q[k] === true;
    return out;
  }
  function sessionView(sess) {
    const entry = sess.app_id ? vault.get(sess.id_hash) : null;
    if (!entry) inquiryState.delete(sess.id_hash);
    const app = sess.app_id
      ? store.db
          .prepare("SELECT app_id, name FROM apps WHERE app_id = ?")
          .get(sess.app_id)
      : null;
    return {
      csrf_token: sess.csrf,
      media_enabled: config.mediaEnabled !== false,
      videos_enabled: config.mediaEnabled !== false && config.videosEnabled !== false,
      app: app ? { id: app.app_id, name: app.name } : null,
      key_active: !!entry,
      key_expires_at: entry ? new Date(entry.expiresAt).toISOString() : null,
      inquiry: entry ? (inquiryState.get(sess.id_hash) ?? null) : null,
      webhook: sess.app_id ? webhookView(sess.app_id) : null,
    };
  }
  function recordMessage(conv, raw, source) {
    const dto = sanitizeMessage(raw, conv.id);
    if (!dto || (dto.conversation_id && dto.conversation_id !== conv.hioask_id))
      return null;
    store.upsertMessage(conv.id, dto, source);
    // Read the durable winner, since stale API/creation events cannot replace a recall.
    const saved = JSON.parse(store.messageRows(conv.id, [dto.id])[0].dto_json);
    for (const a of saved.attachments) store.addMedia(conv.id, a.id, a.content_type);
    return saved;
  }
  function applyStatus(conv, remote) {
    const st = obj(remote)?.status;
    // A delayed/retried event must not reopen an already closed inquiry.
    if (conv.status === "closed") return;
    if (typeof st === "string" && STATUSES.has(st) && st !== conv.status)
      store.setConversationStatus(conv.id, st);
  }

  // ---------- route handlers ----------
  async function authenticateSession(sess, apiKey) {
    const { body: raw } = await gateway.identity(apiKey);
    const ident = unwrap(raw, ["app", "api_key"]);
    const app = obj(ident?.app);
    const appId = app && (typeof app.id === "string" ? app.id : app.app_id);
    if (typeof appId !== "string" || !APP_ID.test(appId))
      throw new HttpError(
        502,
        "GATEWAY_BAD_RESPONSE",
        "Gateway identity response lacks a valid App.",
      );
    if (config.expectedAppId && appId !== config.expectedAppId)
      throw new HttpError(503, "CONFIGURED_APP_MISMATCH", "The configured HIOBuy Key belongs to a different App.");
    if (config.requireProductionKey && ident.api_key?.environment !== "production")
      throw new HttpError(503, "PRODUCTION_KEY_REQUIRED", "A production HIOBuy Key is required for this Demo.");
    const current = store.getSession(sess.id_hash);
    if (!current)
      throw new HttpError(401, "SESSION_REQUIRED", "Session expired.");
    if (current.app_id && current.app_id !== appId)
      throw new HttpError(
        409,
        "APP_MISMATCH",
        "This key belongs to a different App. Start a new session to use it.",
      );
    if (!current.app_id && !store.bindSessionApp(sess.id_hash, appId))
      throw new HttpError(
        409,
        "APP_MISMATCH",
        "Session App changed concurrently.",
      );
    store.upsertApp(appId, plain(app.name, 100) || null);
    vault.set(sess.id_hash, apiKey, appId);
    // Inquiry enablement/scopes/webhook forwarding are managed by HIOBuy admin. A valid Key
    // without inquiry scopes still verifies; flags are reported, never bypassed.
    inquiryState.set(sess.id_hash, inquiryFlags(ident));
    const scopes = Array.isArray(obj(ident.api_key)?.scopes)
      ? ident.api_key.scopes
          .filter((s) => typeof s === "string" && /^[a-z_:.*]{1,64}$/.test(s))
          .slice(0, 50)
      : null;
    return { ...sessionView(store.getSession(sess.id_hash)), scopes };
  }

  async function handleKey(req, res, sess) {
    if (demoDefaults) throw new HttpError(404, "NOT_FOUND", "Not found.");
    const body = await readJson(req, ["api_key"], 2048);
    if (
      typeof body.api_key !== "string" ||
      !PRINTABLE_SECRET.test(body.api_key)
    )
      throw new HttpError(400, "INVALID_KEY_FORMAT", "Key format is invalid.");
    return serialize(sess.id_hash, async () =>
      sendJson(res, 200, await authenticateSession(sess, body.api_key)),
    );
  }
  async function handleBootstrap(req, res, sess) {
    await readJson(req, [], 256);
    if (!demoDefaults)
      throw new HttpError(
        503,
        "DEMO_NOT_CONFIGURED",
        "The demo needs administrator configuration.",
      );
    return serialize(sess.id_hash, async () => {
      const session = await authenticateSession(sess, demoDefaults.getKey());
      const current = store.getSession(sess.id_hash),
        parsed = demoDefaults.product;
      const cached = productCache.get(current.app_id);
      let product;
      if (cached && now() - cached.at < 60_000) product = cached.product;
      else {
        const { body: raw } = await gateway.productDetail(
          requireKey(current),
          parsed,
        );
        product = normalizeProduct(raw, parsed);
        if (!product)
          throw new HttpError(
            502,
            "PRODUCT_DETAIL_UNUSABLE",
            "Product details are unavailable.",
          );
        productCache.set(current.app_id, { product, at: now() });
      }
      store.saveProduct(current.app_id, product);
      const conv = store.latestConversation(
        current.app_id,
        current.user_id,
        parsed.slot,
      );
      sendJson(res, 200, {
        session,
        product,
        conversation: conv?.hioask_id ? conversationView(conv) : null,
      });
    });
  }

  async function handleLookup(req, res, sess) {
    const apiKey = requireKey(sess);
    const body = await readJson(req, ["channel", "value", "language"], 4096);
    const parsed = parseProductInput(body);
    if (demoDefaults && parsed.slot !== demoDefaults.product.slot)
      throw new HttpError(
        403,
        "FIXED_PRODUCT_ONLY",
        "This demo uses one configured product.",
      );
    const { body: raw } = await gateway.productDetail(apiKey, {
      channel: parsed.channel,
      id: parsed.id,
      language: parsed.language,
    });
    const product = normalizeProduct(raw, parsed);
    if (!product)
      throw new HttpError(
        502,
        "PRODUCT_DETAIL_UNUSABLE",
        "Product detail did not include a usable title.",
      );
    store.saveProduct(sess.app_id, product);
    sendJson(res, 200, { product });
  }

  async function handleContact(req, res, sess) {
    const apiKey = requireKey(sess);
    const body = await readJson(req, ["slot", "new_generation"], 1024);
    if (
      typeof body.slot !== "string" ||
      !/^(1688|taobao):[0-9]{5,20}$/.test(body.slot)
    )
      throw new HttpError(400, "INVALID_SLOT", "Invalid product.");
    if (demoDefaults && body.slot !== demoDefaults.product.slot)
      throw new HttpError(
        403,
        "FIXED_PRODUCT_ONLY",
        "This demo uses one configured product.",
      );
    if (
      body.new_generation !== undefined &&
      typeof body.new_generation !== "boolean"
    )
      throw new HttpError(
        400,
        "INVALID_BODY",
        "new_generation must be boolean.",
      );
    return serialize(sess.id_hash, async () => {
      const product = store.getProduct(sess.app_id, body.slot);
      if (!product)
        throw new HttpError(
          404,
          "PRODUCT_NOT_LOADED",
          "Look up the product first.",
        );
      let conv = store.latestConversation(sess.app_id, sess.user_id, body.slot);
      if (body.new_generation) {
        if (!conv || conv.status !== "closed")
          throw new HttpError(
            409,
            "CONVERSATION_STILL_OPEN",
            "Only a closed inquiry can be restarted.",
          );
        conv = null;
      }
      if (!conv) {
        const prev = store.latestConversation(
          sess.app_id,
          sess.user_id,
          body.slot,
        );
        const generation = (prev?.generation ?? 0) + 1;
        const externalId = `inq_${sha256(`${sess.app_id}|${sess.user_id}|${body.slot}|${generation}`).slice(0, 40)}`;
        conv = store.insertConversation({
          appId: sess.app_id,
          userId: sess.user_id,
          slot: body.slot,
          generation,
          externalId,
          title: cardTitle(product.title),
          productUrl: product.url,
          productId: product.product_id,
          channel: product.channel,
          priceLabel: product.price_label,
        });
      }
      if (!conv.hioask_id) {
        const payload = {
          external_conversation_id: conv.external_id,
          external_user_id: sess.user_id,
          language: "en",
          context: {
            type: "product",
            product_url: conv.product_url,
            product_id: conv.product_id,
            product_title: conv.title,
            source: "inquiry_demo",
          },
        };
        const { body: raw } = await gateway.createConversation(
          apiKey,
          payload,
          `create-${conv.external_id}`,
        );
        const remote = unwrap(raw, ["id", "external_conversation_id"]);
        if (
          typeof remote?.id !== "string" ||
          !ID.test(remote.id) ||
          (remote.external_conversation_id &&
            remote.external_conversation_id !== conv.external_id)
        ) {
          throw new HttpError(
            502,
            "GATEWAY_BAD_RESPONSE",
            "Gateway conversation response is invalid.",
          );
        }
        const ctx = obj(remote.context);
        if (ctx && ctx.source !== undefined && ctx.source !== "inquiry_demo")
          throw new HttpError(
            502,
            "SOURCE_MARKER_MISSING",
            "Gateway did not retain the Inquiry Demo source marker.",
          );
        store.setConversationRemote(
          conv.id,
          remote.id,
          STATUSES.has(remote.status) ? remote.status : "pending",
        );
        conv = store.ownedConversation(conv.id, sess.app_id, sess.user_id);
      }
      sendJson(res, 200, { conversation: conversationView(conv) });
    });
  }

  async function handleSend(req, res, sess, conv) {
    const apiKey = requireKey(sess);
    const remoteId = requireRemote(conv);
    const body = await readJson(
      req,
      ["client_message_id", "content", "attachment_ids"],
      128 * 1024,
    );
    const cmid = body.client_message_id;
    if (typeof cmid !== "string" || !UUID.test(cmid))
      throw new HttpError(
        400,
        "INVALID_CLIENT_MESSAGE_ID",
        "client_message_id must be a UUID.",
      );
    const content = body.content === undefined ? "" : body.content;
    if (
      typeof content !== "string" ||
      cpLen(content) > 10000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
    )
      throw new HttpError(400, "INVALID_CONTENT", "Message text is invalid.");
    const ids = body.attachment_ids === undefined ? [] : body.attachment_ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 4 ||
      ids.some((x) => typeof x !== "string" || !UUID.test(x)) ||
      new Set(ids).size !== ids.length
    )
      throw new HttpError(
        400,
        "INVALID_ATTACHMENTS",
        "Up to four distinct attachments.",
      );
    const attachmentIds = ids.map((x) => x.toLowerCase());
    // Original text is kept exactly (leading/trailing whitespace, newlines); trim is used
    // only to decide whether there is any text at all.
    const text = content.trim() ? content : "";
    if (!text && !attachmentIds.length)
      throw new HttpError(400, "EMPTY_MESSAGE", "Enter text or attach media.");
    return serialize(sess.id_hash, async () => {
      let out = store.getOutbound(conv.id, cmid);
      let payload;
      if (out) {
        payload = JSON.parse(out.payload_json);
        if (
          (payload.content ?? "") !== text ||
          JSON.stringify(payload.attachment_ids ?? []) !==
            JSON.stringify(attachmentIds)
        ) {
          throw new HttpError(
            409,
            "CLIENT_MESSAGE_ID_REUSED",
            "This message ID was already used for different content.",
          );
        }
      } else {
        const mine = store.uploadedAttachmentIds(conv.id);
        if (attachmentIds.some((a) => !mine.has(a)))
          throw new HttpError(
            400,
            "UNKNOWN_ATTACHMENT",
            "Attachment does not belong to this conversation.",
          );
        const types = attachmentIds.map(
          (a) => store.getMedia(conv.id, a)?.content_type,
        );
        payload = { client_message_id: cmid };
        if (store.claimCard(conv.id, cmid)) {
          payload.type = "text";
          payload.product_card = {
            url: conv.product_url,
            title: conv.title,
            ...(conv.price_label ? { price_label: conv.price_label } : {}),
          };
        } else {
          payload.type =
            !text && types.length && types.every((t) => t?.startsWith("image/"))
              ? "image"
              : "text";
        }
        if (text) payload.content = text;
        if (attachmentIds.length) payload.attachment_ids = attachmentIds;
        store.insertOutbound(conv.id, cmid, payload);
      }
      const { body: raw } = await gateway.sendMessage(
        apiKey,
        remoteId,
        payload,
        `msg-${conv.external_id.slice(4, 28)}-${cmid}`,
      );
      const msg = recordMessage(
        conv,
        unwrap(raw, ["id", "client_message_id"]),
        "api",
      );
      if (!msg)
        throw new HttpError(
          502,
          "GATEWAY_BAD_RESPONSE",
          "Gateway message response is invalid.",
        );
      store.setOutboundMessage(conv.id, cmid, msg.id);
      const row = store.messageRows(conv.id, [msg.id])[0];
      sendJson(res, 200, { message: messageView(row) });
    });
  }

  function sniff(buf, type) {
    if (type === "image/png")
      return buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (type === "image/jpeg")
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (type === "image/webp")
      return (
        buf.subarray(0, 4).toString("latin1") === "RIFF" &&
        buf.subarray(8, 12).toString("latin1") === "WEBP"
      );
    if (type === "video/mp4")
      return buf.subarray(4, 8).toString("latin1") === "ftyp";
    return false;
  }

  async function handleUpload(req, res, sess, conv, url) {
    if (config.mediaEnabled === false) throw new HttpError(503, "MEDIA_DISABLED", "Images and videos are temporarily unavailable; please send text.");
    const apiKey = requireKey(sess);
    const remoteId = requireRemote(conv);
    const uploadId = url.searchParams.get("upload_id");
    if (
      !uploadId ||
      !UUID.test(uploadId) ||
      [...url.searchParams.keys()].length !== 1
    )
      throw new HttpError(
        400,
        "INVALID_UPLOAD_ID",
        "upload_id must be a UUID.",
      );
    const type = (req.headers["content-type"] ?? "").toLowerCase();
    if (type === "video/mp4" && config.videosEnabled === false)
      throw new HttpError(415, "VIDEOS_DISABLED", "Video uploads are unavailable; use PNG, JPEG or WebP images.");
    if (!(type in MEDIA_TYPES))
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Use PNG, JPEG, WebP or MP4.",
      );
    if (!/^[0-9]{1,9}$/.test(req.headers["content-length"] ?? ""))
      throw new HttpError(411, "LENGTH_REQUIRED", "Content-Length required.");
    const bytes = await readBody(req, MEDIA_TYPES[type]);
    if (!bytes.length || !sniff(bytes, type))
      throw new HttpError(
        400,
        "CONTENT_MISMATCH",
        "File content does not match its type.",
      );
    let filename = null;
    const fh = req.headers["x-filename"];
    if (fh !== undefined) {
      try {
        filename = plain(decodeURIComponent(String(fh)), 128);
      } catch {
        throw new HttpError(400, "INVALID_FILENAME", "Invalid filename.");
      }
      filename = filename?.replace(/[\\/]/g, "_").trim() || null;
    }
    const fingerprint = sha256(
      Buffer.concat([Buffer.from(`${type}|${filename ?? ""}|`), bytes]),
    );
    return serialize(sess.id_hash, async () => {
      const existing = store.getUpload(conv.id, uploadId);
      if (existing && existing.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "UPLOAD_ID_REUSED",
          "Upload ID already used for a different file.",
        );
      if (existing?.attachment_json)
        return sendJson(res, 200, {
          attachment: JSON.parse(existing.attachment_json),
        });
      if (!existing) store.insertUpload(conv.id, uploadId, fingerprint);
      const { body: raw } = await gateway.uploadAttachment(apiKey, remoteId, {
        bytes,
        contentType: type,
        filename: filename ? encodeURIComponent(filename) : null,
        idempotencyKey: `up-${uploadId}`,
      });
      const att = sanitizeAttachment(
        unwrap(raw, ["id", "content_type"]),
        conv.id,
      );
      if (!att || att.content_type !== type)
        throw new HttpError(
          502,
          "GATEWAY_BAD_RESPONSE",
          "Gateway attachment response is invalid.",
        );
      store.completeUpload(conv.id, uploadId, att);
      sendJson(res, 201, { attachment: att });
    });
  }

  async function handleMessages(res, sess, conv, url) {
    const apiKey = requireKey(sess);
    const remoteId = requireRemote(conv);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !CURSOR.test(cursor))
      throw new HttpError(400, "INVALID_CURSOR", "Invalid cursor.");
    if (!cursor) {
      const { body: rawConv } = await gateway.conversation(apiKey, remoteId);
      applyStatus(conv, unwrap(rawConv, ["id", "status"]));
    }
    const { body: raw } = await gateway.listMessages(apiKey, remoteId, cursor);
    const list = Array.isArray(raw?.data) ? raw.data.slice(0, 100) : [];
    const ids = store.tx(() =>
      list
        .map((m) => recordMessage(conv, m, "api"))
        .filter(Boolean)
        .map((m) => m.id),
    );
    const next = obj(raw?.pagination)?.next_cursor;
    const fresh = store.ownedConversation(conv.id, sess.app_id, sess.user_id);
    sendJson(res, 200, {
      messages: store.messageRows(conv.id, ids).map(messageView),
      next_cursor: typeof next === "string" && CURSOR.test(next) ? next : null,
      seq: store.currentSeq(),
      conversation: conversationView(fresh),
    });
  }

  function handleUpdates(res, sess, conv, url) {
    requireKey(sess);
    const since = url.searchParams.get("since") ?? "0";
    if (!/^[0-9]{1,15}$/.test(since))
      throw new HttpError(400, "INVALID_SINCE", "Invalid since.");
    const rows = store.messagesSince(conv.id, Number(since));
    const fresh = store.ownedConversation(conv.id, sess.app_id, sess.user_id);
    sendJson(res, 200, {
      messages: rows.map(messageView),
      seq: rows.length ? rows[rows.length - 1].changed_seq : Number(since),
      conversation: conversationView(fresh),
      webhook: webhookView(sess.app_id),
    });
  }

  async function handleContent(req, res, sess, conv, attachmentId, url) {
    const apiKey = requireKey(sess);
    if (!UUID.test(attachmentId))
      throw new HttpError(404, "NOT_FOUND", "Attachment not found.");
    const media = store.getMedia(conv.id, attachmentId.toLowerCase());
    if (!media) throw new HttpError(404, "NOT_FOUND", "Attachment not found.");
    const keys = [...url.searchParams.keys()];
    if (
      keys.some((k) => k !== "download") ||
      (url.searchParams.has("download") &&
        url.searchParams.get("download") !== "1")
    )
      throw new HttpError(400, "INVALID_QUERY", "Invalid query.");
    let range = req.headers.range;
    if (
      range !== undefined &&
      !/^bytes=([0-9]{1,15}-[0-9]{0,15}|-[0-9]{1,15})$/.test(range)
    )
      throw new HttpError(416, "INVALID_RANGE", "Unsupported range.");
    const up = await gateway.attachmentContent(
      apiKey,
      media.attachment_id,
      range,
    );
    if (up.status === 416) {
      // Authorized (owned locally, accepted by Gateway) but unsatisfiable Range: relay
      // status + Content-Range only, with an empty body.
      const cr416 = up.headers.get("content-range");
      if (!cr416 || !/^bytes \*\/[0-9]{1,15}$/.test(cr416))
        throw new HttpError(
          502,
          "GATEWAY_BAD_RESPONSE",
          "Invalid range response.",
        );
      res.writeHead(416, {
        "Content-Range": cr416,
        "Content-Length": "0",
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "bytes",
      });
      return res.end();
    }
    const ctype = (up.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (ctype !== media.content_type) {
      await up.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        "GATEWAY_BAD_RESPONSE",
        "Unexpected media type.",
      );
    }
    const headers = {
      "Content-Type": media.content_type,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="attachment.${EXT[media.content_type]}"`,
    };
    const len = up.headers.get("content-length");
    if (len && /^[0-9]{1,12}$/.test(len)) headers["Content-Length"] = len;
    const cr = up.headers.get("content-range");
    if (up.status === 206) {
      if (!cr || !/^bytes [0-9]{1,15}-[0-9]{1,15}\/[0-9]{1,15}$/.test(cr)) {
        await up.body?.cancel().catch(() => {});
        throw new HttpError(
          502,
          "GATEWAY_BAD_RESPONSE",
          "Invalid range response.",
        );
      }
      headers["Content-Range"] = cr;
    }
    res.writeHead(up.status, headers);
    if (req.method === "HEAD" || !up.body) {
      await up.body?.cancel().catch(() => {});
      return res.end();
    }
    const stream = Readable.fromWeb(up.body);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  async function handleClose(req, res, sess, conv) {
    const apiKey = requireKey(sess);
    const remoteId = requireRemote(conv);
    const body = await readJson(req, [], 256);
    void body;
    return serialize(sess.id_hash, async () => {
      const { body: raw } = await gateway.close(
        apiKey,
        remoteId,
        `close-${conv.external_id}`,
      );
      const remote = unwrap(raw, ["id", "status"]);
      if (remote?.status !== "closed")
        throw new HttpError(
          502,
          "GATEWAY_BAD_RESPONSE",
          "Close was not confirmed.",
        );
      store.setConversationStatus(conv.id, "closed");
      sendJson(res, 200, {
        conversation: conversationView(
          store.ownedConversation(conv.id, sess.app_id, sess.user_id),
        ),
      });
    });
  }

  function ratingView(raw) {
    const s = unwrap(raw, ["status", "eligible_until"]);
    const r = obj(s?.rating);
    return {
      status: ["not_closed", "available", "expired", "submitted"].includes(
        s?.status,
      )
        ? s.status
        : "unknown",
      eligible_until:
        typeof s?.eligible_until === "string"
          ? s.eligible_until.slice(0, 40)
          : null,
      rating:
        r && Number.isInteger(r.rating)
          ? {
              rating: r.rating,
              comment: plain(r.comment, 1000) ?? "",
              created_at:
                typeof r.created_at === "string"
                  ? r.created_at.slice(0, 40)
                  : null,
            }
          : null,
    };
  }

  async function handleRating(req, res, sess, conv) {
    const apiKey = requireKey(sess);
    const remoteId = requireRemote(conv);
    if (req.method === "GET") {
      const { body } = await gateway.ratingState(apiKey, remoteId);
      return sendJson(res, 200, ratingView(body));
    }
    const body = await readJson(req, ["rating", "comment"], 8192);
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)
      throw new HttpError(400, "INVALID_RATING", "Rating must be 1–5.");
    const comment = body.comment === undefined ? "" : body.comment;
    if (
      typeof comment !== "string" ||
      cpLen(comment) > 1000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment)
    )
      throw new HttpError(400, "INVALID_COMMENT", "Comment is invalid.");
    return serialize(sess.id_hash, async () => {
      const payload = { rating: body.rating, comment };
      const key = `rate-${conv.external_id.slice(4, 28)}-${sha256(JSON.stringify(payload)).slice(0, 24)}`;
      const { body: raw } = await gateway.rate(apiKey, remoteId, payload, key);
      const r = obj(unwrap(raw, ["rating", "id"]));
      sendJson(res, 200, {
        rating:
          r && Number.isInteger(r.rating)
            ? { rating: r.rating, comment: plain(r.comment, 1000) ?? "" }
            : payload,
      });
    });
  }

  async function handleWebhook(req, res) {
    if (
      !/^application\/json(;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] ?? "",
      )
    )
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "JSON required.");
    const raw = await readBody(req, 256 * 1024);
    const candidates = [...webhookSecrets].map(([appId, secret]) => ({
      appId,
      secret,
    }));
    if (!candidates.length)
      throw new HttpError(
        503,
        "WEBHOOK_NOT_CONFIGURED",
        "No HIOBuy-provisioned webhook verification secret is configured.",
      );
    const v = verifySignature(
      req.headers["hiobuy-signature"],
      raw,
      candidates,
      Math.floor(now() / 1000),
    );
    if (!v.ok)
      throw new HttpError(401, v.reason, "Signature verification failed.");
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Invalid JSON.");
    }
    const ev = parseEvent(parsed);
    if (!ev) throw new HttpError(400, "INVALID_EVENT", "Invalid event.");
    if (ev.appId && ev.appId !== v.appId)
      throw new HttpError(403, "APP_MISMATCH", "Event App mismatch.");
    if (ev.type === "ask.message.recalled") {
      const m = ev.message;
      if (ev.appId !== v.appId || !m || typeof m.id !== "string" || !ID.test(m.id) || m.sender_type !== "staff" ||
          !ev.conversation || typeof ev.conversation.id !== "string" || !ID.test(ev.conversation.id) ||
          m.conversation_id !== ev.conversation.id ||
          !validRecallTime(m.recalled_at) || m.content !== "" || m.type !== "text" ||
          (m.attachments !== undefined && (!Array.isArray(m.attachments) || m.attachments.length > 0)) ||
          m.product_card != null)
        throw new HttpError(400, "INVALID_RECALL", "Invalid recall tombstone.");
    }
    const bodyHash = sha256(raw);
    const result = store.tx(() => {
      const prior = store.getEvent(ev.eventId);
      if (prior)
        return prior.body_hash === bodyHash && prior.app_id === v.appId
          ? { status: 200, outcome: "duplicate" }
          : { status: 409, outcome: "conflict" };
      const remoteConvId = ev.conversation?.id ?? ev.message?.conversation_id;
      const conv =
        typeof remoteConvId === "string"
          ? store.conversationByRemote(remoteConvId)
          : null;
      if (!conv || conv.app_id !== v.appId) {
        store.insertEvent({
          eventId: ev.eventId,
          bodyHash,
          appId: v.appId,
          type: ev.type,
          outcome: "ignored",
        });
        return { status: 202, outcome: "ignored" };
      }
      if (ev.conversation && ev.conversation.id === conv.hioask_id)
        applyStatus(conv, ev.conversation);
      if ((ev.type === "ask.message.created" || ev.type === "ask.message.recalled") && ev.message)
        recordMessage(conv, ev.message, "webhook");
      store.insertEvent({
        eventId: ev.eventId,
        bodyHash,
        appId: v.appId,
        type: ev.type,
        conversationId: conv.id,
        outcome: "applied",
      });
      return { status: 200, outcome: "applied" };
    });
    if (result.status === 409)
      throw new HttpError(
        409,
        "EVENT_ID_CONFLICT",
        "Event ID reused with a different body.",
      );
    sendJson(res, result.status, { received: true, outcome: result.outcome });
  }

  // ---------- dispatcher ----------
  async function dispatch(req, res) {
    baseHeaders(res);
    const host = req.headers.host;
    if (typeof host !== "string" || !allowedHosts.has(host))
      throw new HttpError(421, "INVALID_HOST", "Invalid host.");
    if (req.url.length > 2048 || !req.url.startsWith("/"))
      throw new HttpError(414, "INVALID_URL", "Invalid URL.");
    const url = new URL(req.url, config.publicOrigin || `http://${host}`);
    const p = url.pathname;
    const method = req.method;

    if (p === "/hooks/hiobuy") {
      if (method !== "POST")
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      return handleWebhook(req, res);
    }
    if (!p.startsWith("/api/")) {
      const asset = assets.get(p);
      if (!asset || (method !== "GET" && method !== "HEAD") || url.search)
        throw new HttpError(404, "NOT_FOUND", "Not found.");
      res.writeHead(200, {
        "Content-Type": asset.type,
        "Cache-Control": "no-cache",
        "Content-Length": asset.body.length,
      });
      return res.end(method === "HEAD" ? undefined : asset.body);
    }

    const unsafe = method !== "GET" && method !== "HEAD";
    const origin = req.headers.origin;
    if (unsafe || origin !== undefined) {
      if (origin !== (config.publicOrigin || `http://${host}`))
        throw new HttpError(
          403,
          "INVALID_ORIGIN",
          "Cross-origin request rejected.",
        );
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none")
      throw new HttpError(
        403,
        "INVALID_ORIGIN",
        "Cross-site request rejected.",
      );

    const sid = parseCookie(req);
    let sess = sid ? store.getSession(sha256(sid)) : null;
    if (p === "/api/session" && method === "GET") {
      if (!sess) sess = newSession(res);
      return sendJson(res, 200, sessionView(sess));
    }
    if (!sess)
      throw new HttpError(
        401,
        "SESSION_REQUIRED",
        "Session required; reload the page.",
      );
    if (unsafe) {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !safeEqual(token, sess.csrf))
        throw new HttpError(403, "INVALID_CSRF", "CSRF validation failed.");
    }

    if (p === "/api/bootstrap" && method === "POST")
      return handleBootstrap(req, res, sess);
    if (p === "/api/key" && method === "POST") return handleKey(req, res, sess);
    if (p === "/api/key/forget" && method === "POST") {
      await readJson(req, [], 256);
      vault.delete(sess.id_hash);
      inquiryState.delete(sess.id_hash);
      return sendJson(res, 200, sessionView(sess));
    }
    if (p === "/api/session/reset" && method === "POST") {
      await readJson(req, [], 256);
      vault.delete(sess.id_hash);
      inquiryState.delete(sess.id_hash);
      store.deleteSession(sess.id_hash);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=; HttpOnly; SameSite=Strict${secureCookie}; Path=/; Max-Age=0`,
      );
      return sendJson(res, 200, { reset: true });
    }
    if (p === "/api/products/lookup" && method === "POST")
      return handleLookup(req, res, sess);
    if (p === "/api/conversations") {
      if (method === "POST") return handleContact(req, res, sess);
      if (method === "GET") {
        requireKey(sess);
        return sendJson(res, 200, {
          conversations: store
            .listConversations(sess.app_id, sess.user_id)
            .filter(
              (c) => !demoDefaults || c.slot === demoDefaults.product.slot,
            )
            .map(conversationView),
        });
      }
    }
    const m =
      /^\/api\/conversations\/([^/]{1,20})(?:\/(messages|updates|attachments|close|rating)(?:\/([^/]{1,64})\/content)?)?$/.exec(
        p,
      );
    if (m) {
      requireKey(sess);
      const conv = owned(sess, m[1]);
      const sub = m[2];
      const aid = m[3];
      if (!sub && method === "GET")
        return sendJson(res, 200, { conversation: conversationView(conv) });
      if (sub === "messages" && method === "GET")
        return handleMessages(res, sess, conv, url);
      if (sub === "messages" && method === "POST")
        return handleSend(req, res, sess, conv);
      if (sub === "updates" && method === "GET")
        return handleUpdates(res, sess, conv, url);
      if (sub === "attachments" && !aid && method === "POST")
        return handleUpload(req, res, sess, conv, url);
      if (
        sub === "attachments" &&
        aid &&
        (method === "GET" || method === "HEAD")
      )
        return handleContent(req, res, sess, conv, aid, url);
      if (sub === "close" && method === "POST")
        return handleClose(req, res, sess, conv);
      if (sub === "rating" && (method === "GET" || method === "POST"))
        return handleRating(req, res, sess, conv);
    }
    throw new HttpError(404, "NOT_FOUND", "Not found.");
  }

  function onRequest(req, res) {
    dispatch(req, res).catch((err) => {
      // Drain unread request bodies safely without echoing them.
      if (!req.complete) req.resume();
      sendError(res, err);
    });
  }

  return {
    store, vault,
    webhookConfiguredApps() { return [...webhookSecrets.keys()]; },
    onRequest,
    setLocalPort(port) { allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]); },
    close() { vault.stopPurge(); vault.clear(); webhookSecrets.clear(); inquiryState.clear(); },
  };
}
