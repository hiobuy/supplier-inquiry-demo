import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, symlinkSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startDemo, startHttpGateway, writeWebhookConfig, request, Browser, openInquiry, fakeGateway, KEY_A, KEY_A2, KEY_B, KEY_NOSCOPE, SECRET_A, SECRET_B, PNG } from "./helpers.mjs";
import { signPayload } from "../src/webhook.mjs";
import { KEY_TTL_MS } from "../src/keyvault.mjs";
import { ROOT_DIR, ConfigError, loadWebhookSecrets, validateConfig } from "../src/config.mjs";

async function withDemo(fn, opts) {
  const d = await startDemo(opts);
  try { await fn(d); } finally { await d.app.close(); }
}
const dbBytes = (d) => readFileSync(path.join(d.dataDir, "inquiry-demo.sqlite"));

test("Host, Origin, Sec-Fetch-Site and CSRF enforcement", () => withDemo(async ({ port }) => {
  assert.equal((await request(port, { path: "/api/session", headers: { host: "evil.com" } })).status, 421);
  assert.equal((await request(port, { path: "/", headers: { host: `localhost:${port + 1}` } })).status, 421);
  const b = new Browser(port); await b.init();
  const body = JSON.stringify({ api_key: KEY_A });
  const base = { cookie: b.cookie, "content-type": "application/json" };
  assert.equal((await request(port, { method: "POST", path: "/api/key", headers: { ...base, "x-csrf-token": b.csrf }, body })).json.error.code, "INVALID_ORIGIN");
  assert.equal((await request(port, { method: "POST", path: "/api/key", headers: { ...base, origin: "http://evil.com", "x-csrf-token": b.csrf }, body })).status, 403);
  assert.equal((await request(port, { method: "POST", path: "/api/key", headers: { ...base, origin: `http://localhost:${port}`, "x-csrf-token": "wrong" }, body })).json.error.code, "INVALID_CSRF");
  assert.equal((await request(port, { method: "POST", path: "/api/key", headers: { ...base, origin: `http://localhost:${port}` }, body })).json.error.code, "INVALID_CSRF");
  assert.equal((await b.call("GET", "/api/session", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await b.call("GET", "/api/session", undefined, { origin: "http://evil.com" })).status, 403);
  assert.equal((await b.login(KEY_A)).status, 200);
  const r = await request(port, { path: "/api/session" });
  const sc = r.headers["set-cookie"][0];
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.match(r.headers["content-security-policy"], /default-src 'self'/);
}));

test("bad key, missing scope and unavailable Gateway stay explicit; no mock fallback", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init();
  const bad = await b.login("bogus-key-value-000000000000");
  assert.equal(bad.status, 401); assert.equal(bad.json.error.code, "INVALID_API_KEY");
  assert.ok(!bad.body.toString().includes("bogus-key-value"), "key not echoed");
  // Valid Key without inquiry scopes: identity verifies (200) and reports HIOBuy-managed flags.
  const n = new Browser(port); await n.init();
  const noscope = await n.login(KEY_NOSCOPE);
  assert.equal(noscope.status, 200); assert.equal(noscope.json.app.id, "app_n");
  assert.deepEqual(noscope.json.inquiry, { enabled: false, mapped: false, read: false, write: false, webhook_configured: false });
  assert.deepEqual(noscope.json.webhook, { status: "not_configured", managed_by: "hiobuy" }, "App N does not inherit App A/B webhook");
  assert.ok(!noscope.body.toString().includes(KEY_NOSCOPE));
  assert.deepEqual((await n.call("GET", "/api/session")).json.inquiry, noscope.json.inquiry);
  assert.equal((await n.call("POST", "/api/products/lookup", { channel: "1688", value: "673124809943" })).status, 200);
  const write = await n.call("POST", "/api/conversations", { slot: "1688:673124809943" });
  assert.equal(write.status, 403); assert.equal(write.json.error.code, "INSUFFICIENT_SCOPE", "inquiry write still enforced");
  assert.ok(gateway.calls.some((c) => c.path === "/v1/ask/conversations" && c.headers.authorization === `Bearer ${KEY_NOSCOPE}`));
  assert.equal((await b.call("GET", "/api/conversations")).json.error.code, "KEY_REQUIRED");
  assert.equal((await b.call("POST", "/api/products/lookup", { channel: "1688", value: "673124809943" })).json.error.code, "KEY_REQUIRED");
  gateway.down = true;
  const down = await b.login(KEY_A);
  assert.equal(down.status, 503); assert.equal(down.json.error.code, "GATEWAY_UNAVAILABLE");
  assert.equal((await b.call("GET", "/api/session")).json.key_active, false);
  assert.equal((await b.login("short")).json.error.code, "INVALID_KEY_FORMAT");
}));

test("secret confinement: key never in DB/responses/cookies; DB mode 600; Gateway gets Bearer only", () => withDemo(async (d) => {
  const b = new Browser(d.port); await b.init();
  const r = await b.login(KEY_A);
  assert.equal(r.status, 200);
  assert.equal(r.json.app.id, "app_a");
  assert.deepEqual(r.json.webhook, { status: "configured", managed_by: "hiobuy" });
  assert.equal(r.json.inquiry.write, true);
  assert.ok(!r.body.toString().includes(KEY_A));
  await openInquiry(b);
  const s = await b.call("GET", "/api/session");
  assert.ok(!s.body.toString().includes(KEY_A) && !s.body.toString().includes(SECRET_A) && !s.body.toString().includes(SECRET_B));
  assert.ok(!dbBytes(d).includes(Buffer.from(KEY_A)), "key absent from SQLite");
  assert.ok(!dbBytes(d).includes(Buffer.from(SECRET_A)), "signing secret absent from SQLite");
  assert.ok(!d.gateway.calls.some((c) => c.path.includes("/webhook")), "Demo never self-registers webhooks");
  assert.deepEqual(d.app.webhookConfiguredApps().sort(), ["app_a", "app_b"]);
  assert.equal(statSync(path.join(d.dataDir, "inquiry-demo.sqlite")).mode & 0o777, 0o600);
  assert.ok(!dbBytes(d).includes(Buffer.from(b.cookie.split("=")[1])), "raw session ID not stored");
  for (const c of d.gateway.calls) {
    assert.ok(c.path.startsWith("/v1/"));
    assert.equal(c.headers.authorization, `Bearer ${KEY_A}`);
    assert.equal(c.headers["user-agent"], "Inquiry-Demo/0.1");
    assert.equal(c.headers.cookie, undefined);
    assert.ok(!c.path.includes(KEY_A));
  }
}));

test("key TTL expiry, same-App re-entry, different-App rejection, restart recovery", async () => {
  const clock = { t: Date.UTC(2026, 10, 13, 12) };
  const d = await startDemo({ clock });
  const b = new Browser(d.port); await b.init();
  await b.login(KEY_A);
  const conv = await openInquiry(b);
  clock.t += KEY_TTL_MS;
  assert.equal((await b.call("GET", "/api/conversations")).json.error.code, "KEY_REQUIRED");
  assert.equal((await b.call("GET", `/api/conversations/${conv.id}/updates`)).json.error.code, "KEY_REQUIRED");
  const other = await b.login(KEY_B);
  assert.equal(other.status, 409); assert.equal(other.json.error.code, "APP_MISMATCH");
  assert.equal((await b.call("GET", "/api/conversations")).json.error.code, "KEY_REQUIRED", "other App key not retained");
  assert.equal((await b.login(KEY_A2)).status, 200, "another key of the same App restores");
  assert.equal((await b.call("GET", "/api/conversations")).json.conversations[0].id, conv.id);
  await d.app.close();
  // Restart with same data dir: session persists, keys do not.
  const d2 = await startDemo({ dataDir: d.dataDir, clock, gateway: d.gateway });
  try {
    const b2 = new Browser(d2.port, b.cookie); await b2.init();
    assert.equal(b2.cookie, b.cookie);
    assert.equal((await b2.call("GET", "/api/session")).json.key_active, false);
    assert.equal((await b2.call("GET", `/api/conversations/${conv.id}/messages`)).json.error.code, "KEY_REQUIRED");
    assert.equal((await b2.login(KEY_B)).json.error.code, "APP_MISMATCH");
    await b2.login(KEY_A);
    assert.equal((await b2.call("GET", "/api/conversations")).json.conversations.length, 1);
  } finally { await d2.app.close(); }
});

test("Contact Supplier: concurrent/repeated clicks reuse one conversation with stable idempotency key", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  await b.call("POST", "/api/products/lookup", { channel: "1688", value: "673124809943" });
  const results = await Promise.all(Array.from({ length: 6 }, () => b.call("POST", "/api/conversations", { slot: "1688:673124809943" })));
  const ids = new Set(results.map((r) => r.json.conversation.id));
  assert.equal(ids.size, 1);
  const creates = gateway.calls.filter((c) => c.path === "/v1/ask/conversations" && c.method === "POST");
  assert.equal(creates.length, 1);
  const body = creates[0].body;
  assert.equal(body.context.source, "inquiry_demo");
  assert.equal(body.context.product_url, "https://detail.1688.com/offer/673124809943.html");
  assert.match(body.external_user_id, /^demo_[0-9a-f]{24}$/);
  assert.equal(results[0].json.conversation.source, "Inquiry Demo");
  // Different product -> separate conversation; unknown product -> rejected.
  const other = await openInquiry(b, "123456789");
  assert.notEqual(other.id, [...ids][0]);
  assert.equal((await b.call("POST", "/api/conversations", { slot: "1688:99999999" })).json.error.code, "PRODUCT_NOT_LOADED");
  // Browser cannot choose ownership fields.
  assert.equal((await b.call("POST", "/api/conversations", { slot: "1688:673124809943", external_user_id: "victim" })).json.error.code, "UNKNOWN_FIELD");
  assert.equal((await b.call("POST", "/api/conversations", { slot: "1688:673124809943", new_generation: true })).json.error.code, "CONVERSATION_STILL_OPEN");
}));

test("Contact Supplier retry after Gateway failure reuses the same request key", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  await b.call("POST", "/api/products/lookup", { channel: "1688", value: "673124809943" });
  gateway.failNextCreate = true;
  const fail = await b.call("POST", "/api/conversations", { slot: "1688:673124809943" });
  assert.equal(fail.status, 503); assert.equal(fail.json.error.code, "SERVICE_UNAVAILABLE");
  const ok = await b.call("POST", "/api/conversations", { slot: "1688:673124809943" });
  assert.equal(ok.status, 200); assert.equal(ok.json.conversation.ready, true);
  const keys = gateway.calls.filter((c) => c.path === "/v1/ask/conversations").map((c) => c.headers["idempotency-key"]);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  const exts = gateway.calls.filter((c) => c.path === "/v1/ask/conversations").map((c) => c.body.external_conversation_id);
  assert.equal(exts[0], exts[1]);
}));

test("App/session/conversation/media isolation", () => withDemo(async ({ port }) => {
  const a = new Browser(port); await a.init(); await a.login(KEY_A);
  const conv = await openInquiry(a);
  const up = await a.call("POST", `/api/conversations/${conv.id}/attachments?upload_id=${randomUUID()}`, PNG, { "content-type": "image/png" });
  assert.equal(up.status, 201);
  const content = up.json.attachment.content_path;
  for (const key of [KEY_A2, KEY_B]) {
    const x = new Browser(port); await x.init(); await x.login(key);
    assert.equal((await x.call("GET", `/api/conversations/${conv.id}`)).status, 404);
    assert.equal((await x.call("GET", `/api/conversations/${conv.id}/messages`)).status, 404);
    assert.equal((await x.call("GET", content)).status, 404);
    assert.equal((await x.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: randomUUID(), content: "hi" })).status, 404);
    assert.equal((await x.call("GET", "/api/conversations")).json.conversations.length, 0);
    // Even within own conversation, a foreign attachment ID cannot be bound or read.
    const own = await openInquiry(x);
    const bind = await x.call("POST", `/api/conversations/${own.id}/messages`, { client_message_id: randomUUID(), attachment_ids: [up.json.attachment.id] });
    assert.equal(bind.json.error.code, "UNKNOWN_ATTACHMENT");
    assert.equal((await x.call("GET", `/api/conversations/${own.id}/attachments/${up.json.attachment.id}/content`)).status, 404);
  }
  const anon = await request(port, { path: content });
  assert.equal(anon.status, 401);
}));

test("messages: product card once, stable retries, conflicting reuse, late success never duplicates", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  const cmid = randomUUID();
  gateway.failNextSend = true;
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: cmid, content: "Is MOQ 10?" })).status, 503);
  const r1 = await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: cmid, content: "Is MOQ 10?" });
  const r2 = await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: cmid, content: "Is MOQ 10?" });
  assert.equal(r1.json.message.id, r2.json.message.id);
  assert.equal(r1.json.message.product_card.url, "https://detail.1688.com/offer/673124809943.html");
  const sends = gateway.calls.filter((c) => c.path.endsWith("/messages") && c.method === "POST");
  assert.equal(new Set(sends.map((c) => c.headers["idempotency-key"])).size, 1);
  assert.deepEqual(sends[0].body, sends[2].body);
  assert.equal(gateway.conversations.get([...gateway.conversations.keys()][0]).messages.length, 1);
  const conflict = await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: cmid, content: "changed" });
  assert.equal(conflict.json.error.code, "CLIENT_MESSAGE_ID_REUSED");
  const second = await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: randomUUID(), content: "Second" });
  assert.equal(second.json.message.product_card, undefined);
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: randomUUID() })).json.error.code, "EMPTY_MESSAGE");
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: "not-uuid", content: "x" })).status, 400);
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: randomUUID(), content: "x", type: "staff" })).json.error.code, "UNKNOWN_FIELD");
}));

test("uploads: type/magic checks, stable upload IDs, Range and download proxy", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  const p = (id) => `/api/conversations/${conv.id}/attachments?upload_id=${id}`;
  assert.equal((await b.call("POST", p(randomUUID()), Buffer.from("<svg/>"), { "content-type": "image/svg+xml" })).status, 415);
  assert.equal((await b.call("POST", p(randomUUID()), Buffer.from("not a png at all"), { "content-type": "image/png" })).json.error.code, "CONTENT_MISMATCH");
  assert.equal((await b.call("POST", p("../../x"), PNG, { "content-type": "image/png" })).status, 400);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1); PNG.copy(big);
  assert.equal((await b.call("POST", p(randomUUID()), big, { "content-type": "image/png" })).status, 413);
  const uid = randomUUID();
  const u1 = await b.call("POST", p(uid), PNG, { "content-type": "image/png", "x-filename": encodeURIComponent("../a<b>.png") });
  const u2 = await b.call("POST", p(uid), PNG, { "content-type": "image/png", "x-filename": encodeURIComponent("../a<b>.png") });
  assert.equal(u1.status, 201); assert.equal(u2.status, 200);
  assert.equal(u1.json.attachment.id, u2.json.attachment.id);
  assert.equal(gateway.calls.filter((c) => c.path.endsWith("/attachments")).length, 1);
  assert.equal((await b.call("POST", p(uid), Buffer.concat([PNG, Buffer.from([1])]), { "content-type": "image/png" })).json.error.code, "UPLOAD_ID_REUSED");
  const path_ = u1.json.attachment.content_path;
  const full = await b.call("GET", path_);
  assert.equal(full.status, 200); assert.equal(full.headers["content-type"], "image/png");
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  assert.match(full.headers["cache-control"], /no-store/);
  assert.ok(full.body.equals(PNG));
  const part = await b.call("GET", path_, undefined, { range: "bytes=0-7" });
  assert.equal(part.status, 206); assert.equal(part.headers["content-range"], `bytes 0-7/${PNG.length}`);
  assert.equal(part.body.length, 8);
  assert.equal((await b.call("GET", path_, undefined, { range: "bytes=0-1,4-5" })).status, 416);
  assert.match((await b.call("GET", `${path_}?download=1`)).headers["content-disposition"], /^attachment; filename="attachment\.png"$/);
  assert.equal((await b.call("GET", `${path_}?url=http://evil`)).status, 400);
  const send = await b.call("POST", `/api/conversations/${conv.id}/messages`, { client_message_id: randomUUID(), attachment_ids: [u1.json.attachment.id] });
  assert.equal(send.status, 200);
  const sent = gateway.calls.filter((c) => c.path.endsWith("/messages") && c.method === "POST").at(-1).body;
  assert.equal(sent.type, "text", "first message carries the product card and stays type text");
}));

async function webhookSetup(port) {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  return { b, conv };
}
function postHook(port, body, secret, ts) {
  const raw = Buffer.from(JSON.stringify(body));
  return request(port, { method: "POST", path: "/hooks/hiobuy", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "hiobuy-signature": signPayload(secret, ts, raw), "content-length": String(raw.length) }, body: raw });
}

test("webhook: signature, expiry, dedup, conflict, App ownership, privacy", () => withDemo(async ({ port, gateway, clock, dataDir }) => {
  const ts = Math.floor(clock.t / 1000);
  const { b, conv } = await webhookSetup(port);
  const remoteId = [...gateway.conversations.keys()][0];
  const staff = gateway.addStaffMessage(remoteId, "Yes, MOQ is 10.");
  const event = { event_id: "evt_1", type: "ask.message.created", created_at: "2026-11-13T12:00:00Z", external_app_id: "x", conversation: { id: remoteId, status: "waiting_customer" }, message: staff };
  const secretA = SECRET_A;
  assert.equal((await postHook(port, event, "wrong_secret_0123456789", ts)).status, 401);
  assert.equal((await postHook(port, event, secretA, ts - 301)).json.error.code, "SIGNATURE_EXPIRED");
  const ok = await postHook(port, event, secretA, ts);
  assert.equal(ok.status, 200); assert.equal(ok.json.outcome, "applied");
  assert.equal((await postHook(port, event, secretA, ts)).json.outcome, "duplicate");
  assert.equal((await postHook(port, { ...event, message: { ...staff, content: "tampered" } }, secretA, ts)).status, 409);
  const up = await b.call("GET", `/api/conversations/${conv.id}/updates?since=0`);
  const got = up.json.messages.filter((m) => m.id === staff.id);
  assert.equal(got.length, 1); assert.equal(got[0].arrival, "webhook"); assert.equal(got[0].content, "Yes, MOQ is 10.");
  assert.equal(up.json.conversation.status, "waiting_customer");
  // App B's verified webhook cannot inject into App A's conversation.
  // (No App B login needed: verification secrets come from the admin-provisioned file.)
  const foreign = await postHook(port, { event_id: "evt_2", type: "ask.message.created", conversation: { id: remoteId }, message: { ...staff, id: "msg_foreign", content: "PRIVATE-FOREIGN-TEXT" } }, SECRET_B, ts);
  assert.equal(foreign.status, 202); assert.equal(foreign.json.outcome, "ignored");
  assert.ok(!(await b.call("GET", `/api/conversations/${conv.id}/updates?since=0`)).json.messages.some((m) => m.id === "msg_foreign"));
  assert.ok(!readFileSync(path.join(dataDir, "inquiry-demo.sqlite")).includes(Buffer.from("PRIVATE-FOREIGN-TEXT")), "ignored body not persisted");
  // Wrong host / method rejected.
  assert.equal((await request(port, { method: "GET", path: "/hooks/hiobuy", headers: { host: `127.0.0.1:${port}` } })).status, 405);
}));

test("reconciliation: API-recovered vs webhook labels, no duplicates by stable IDs", () => withDemo(async ({ port, gateway, clock }) => {
  const { b, conv } = await webhookSetup(port);
  const remoteId = [...gateway.conversations.keys()][0];
  const ts = Math.floor(clock.t / 1000);
  const secretA = SECRET_A;
  const m1 = gateway.addStaffMessage(remoteId, "Recovered reply");
  const r1 = await b.call("GET", `/api/conversations/${conv.id}/messages`);
  assert.equal(r1.json.messages.find((m) => m.id === m1.id).arrival, "recovered");
  clock.t += 1000;
  await postHook(port, { event_id: "evt_late", type: "ask.message.created", conversation: { id: remoteId }, message: m1 }, secretA, ts);
  const after = (await b.call("GET", `/api/conversations/${conv.id}/updates?since=0`)).json.messages.filter((m) => m.id === m1.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].arrival, "recovered", "polling-first stays recovered");
  assert.equal(after[0].webhook_confirmed, true);
  const m2 = gateway.addStaffMessage(remoteId, "Webhook reply");
  await postHook(port, { event_id: "evt_m2", type: "ask.message.created", conversation: { id: remoteId }, message: m2 }, secretA, ts);
  clock.t += 1000;
  const r2 = await b.call("GET", `/api/conversations/${conv.id}/messages`);
  assert.equal(r2.json.messages.filter((m) => m.id === m2.id).length, 1);
  assert.equal(r2.json.messages.find((m) => m.id === m2.id).arrival, "webhook");
  assert.equal((await b.call("GET", `/api/conversations/${conv.id}/messages?cursor=..%2F..%2Fx%3Fy`)).json.error.code, "INVALID_CURSOR");
}));

test("restricted paths and bodies", () => withDemo(async ({ port }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  for (const p of ["/../.dev.vars", "/.dev.vars", "/%2e%2e/package.json", "/app.js?x=1", "/public/app.js", "/src/server.mjs", "/config.example.json"]) {
    assert.equal((await b.call("GET", p)).status, 404, p);
  }
  assert.equal((await b.call("GET", "/app.js")).status, 200);
  assert.equal((await b.call("GET", "/api/conversations/1/attachments/..%2F..%2Fx/content")).status, 404);
  assert.equal((await b.call("GET", "/api/conversations/abc")).status, 404);
  assert.equal((await b.call("POST", "/api/products/lookup", Buffer.from("value=1"), { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await b.call("POST", "/api/products/lookup", { value: "x".repeat(20000) })).status, 413);
  assert.equal((await b.call("POST", "/api/products/lookup", { value: "673124809943", channel: "1688", gateway: "http://evil" })).json.error.code, "UNKNOWN_FIELD");
  assert.equal((await b.call("POST", "/api/products/lookup", { value: "https://evil.com/offer/1.html" })).json.error.code, "INVALID_PRODUCT_INPUT");
  const ok = await b.call("POST", "/api/products/lookup", { channel: "1688", value: "673124809943" });
  assert.deepEqual(ok.json.product.images, ["https://cbu01.alicdn.com/img/ibank/a.jpg", "https://global-img-cdn.1688.com/img/ibank/O1CN01test.jpg?x=1"]);
  assert.match(ok.headers["content-security-policy"], /img-src 'self' https:\/\/\*\.alicdn\.com https:\/\/global-img-cdn\.1688\.com;/);
  assert.equal(ok.json.product.price_label, "CNY 12.50");
  assert.equal(ok.json.product.url, "https://detail.1688.com/offer/673124809943.html");
  assert.equal((await b.call("DELETE", "/api/conversations")).status, 404);
}));

test("close {} and one-time rating with stable request keys; explicit new generation", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  assert.equal((await b.call("GET", `/api/conversations/${conv.id}/rating`)).json.status, "not_closed");
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/close`, { reason: "x" })).json.error.code, "UNKNOWN_FIELD");
  const c1 = await b.call("POST", `/api/conversations/${conv.id}/close`, {});
  const c2 = await b.call("POST", `/api/conversations/${conv.id}/close`, {});
  assert.equal(c1.json.conversation.status, "closed"); assert.equal(c2.json.conversation.status, "closed");
  const closes = gateway.calls.filter((c) => c.path.endsWith("/close"));
  assert.deepEqual(closes[0].body, {}); assert.equal(closes[0].headers["idempotency-key"], closes[1].headers["idempotency-key"]);
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/rating`, { rating: 6 })).json.error.code, "INVALID_RATING");
  assert.equal((await b.call("POST", `/api/conversations/${conv.id}/rating`, { rating: 5, comment: "Great", staff: 1 })).status, 400);
  const r1 = await b.call("POST", `/api/conversations/${conv.id}/rating`, { rating: 5, comment: "Great" });
  await b.call("POST", `/api/conversations/${conv.id}/rating`, { rating: 5, comment: "Great" });
  assert.equal(r1.json.rating.rating, 5);
  const rates = gateway.calls.filter((c) => c.path.endsWith("/rating") && c.method === "POST");
  assert.equal(rates[0].headers["idempotency-key"], rates[1].headers["idempotency-key"]);
  assert.equal((await b.call("GET", `/api/conversations/${conv.id}/rating`)).json.status, "submitted");
  // Closed history retained; repeat Contact returns the closed one; explicit new generation creates #2.
  const again = await b.call("POST", "/api/conversations", { slot: "1688:673124809943" });
  assert.equal(again.json.conversation.id, conv.id); assert.equal(again.json.conversation.status, "closed");
  const gen2 = await b.call("POST", "/api/conversations", { slot: "1688:673124809943", new_generation: true });
  assert.equal(gen2.json.conversation.generation, 2); assert.notEqual(gen2.json.conversation.id, conv.id);
  assert.equal((await b.call("GET", "/api/conversations")).json.conversations.length, 2);
}));

test("unknown session cannot reach APIs; session reset unbinds App", () => withDemo(async ({ port }) => {
  assert.equal((await request(port, { path: "/api/conversations" })).json.error.code, "SESSION_REQUIRED");
  assert.equal((await request(port, { path: "/api/conversations", headers: { cookie: `inq_sid=${"A".repeat(43)}` } })).json.error.code, "SESSION_REQUIRED");
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  await openInquiry(b);
  assert.equal((await b.call("POST", "/api/session/reset", {})).status, 200);
  assert.equal((await b.call("GET", "/api/conversations")).json.error.code, "SESSION_REQUIRED");
  const fresh = new Browser(port); await fresh.init(); await fresh.login(KEY_A);
  assert.equal((await fresh.call("GET", "/api/conversations")).json.conversations.length, 0);
}));

const sendsOf = (gateway) => gateway.calls.filter((c) => c.path.endsWith("/messages") && c.method === "POST");

test("messages keep exact original text (whitespace/newlines); retries must repeat it exactly", () => withDemo(async ({ port, gateway }) => {
  const b = new Browser(port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  const url = `/api/conversations/${conv.id}/messages`;
  const text = "  Line 1\n\n\tLine 2 with trailing spaces   \n";
  const cmid = randomUUID();
  gateway.failNextSend = true;
  assert.equal((await b.call("POST", url, { client_message_id: cmid, content: text })).status, 503);
  const ok = await b.call("POST", url, { client_message_id: cmid, content: text });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.message.content, text, "returned message keeps exact original text");
  assert.ok(sendsOf(gateway).every((c) => c.body.content === text), "upstream payload keeps exact original text on every attempt");
  for (const variant of [text.trim(), ` ${text}`, text.replace("\n\n", "\n")]) {
    const r = await b.call("POST", url, { client_message_id: cmid, content: variant });
    assert.equal(r.status, 409); assert.equal(r.json.error.code, "CLIENT_MESSAGE_ID_REUSED");
  }
  const again = await b.call("POST", url, { client_message_id: cmid, content: text });
  assert.equal(again.json.message.id, ok.json.message.id);
  assert.equal(new Set(sendsOf(gateway).map((c) => c.headers["idempotency-key"])).size, 1);
  const stored = (await b.call("GET", url)).json.messages.find((m) => m.id === ok.json.message.id);
  assert.equal(stored.content, text);
  // All-whitespace text is blank: rejected alone, omitted when media is attached.
  assert.equal((await b.call("POST", url, { client_message_id: randomUUID(), content: " \n\t " })).json.error.code, "EMPTY_MESSAGE");
  const up = await b.call("POST", `/api/conversations/${conv.id}/attachments?upload_id=${randomUUID()}`, PNG, { "content-type": "image/png" });
  const img = await b.call("POST", url, { client_message_id: randomUUID(), content: " \n ", attachment_ids: [up.json.attachment.id] });
  assert.equal(img.status, 200);
  const last = sendsOf(gateway).at(-1).body;
  assert.equal(last.content, undefined); assert.equal(last.type, "image");
}));

test("media Range edges over real local HTTP: 206 edges, authorized 416 relayed, no unowned leak", async () => {
  const hg = await startHttpGateway();
  const d = await startDemo({ gateway: hg.gateway, gatewayOrigin: hg.origin, fetchImpl: globalThis.fetch });
  try {
    const b = new Browser(d.port); await b.init();
    assert.equal((await b.login(KEY_A)).status, 200);
    const conv = await openInquiry(b);
    const up = await b.call("POST", `/api/conversations/${conv.id}/attachments?upload_id=${randomUUID()}`, PNG, { "content-type": "image/png" });
    assert.equal(up.status, 201);
    const p = up.json.attachment.content_path;
    const size = PNG.length;
    const cases = [["bytes=0-0", 0, 0], [`bytes=${size - 1}-${size - 1}`, size - 1, size - 1], ["bytes=-8", size - 8, size - 1], [`bytes=60-99999`, 60, size - 1], [`bytes=0-`, 0, size - 1]];
    for (const [range, s, e] of cases) {
      const r = await b.call("GET", p, undefined, { range });
      assert.equal(r.status, 206, range);
      assert.equal(r.headers["content-range"], `bytes ${s}-${e}/${size}`, range);
      assert.ok(r.body.equals(PNG.subarray(s, e + 1)), range);
      assert.equal(r.headers["content-type"], "image/png");
    }
    for (const range of [`bytes=${size}-`, "bytes=9999-10000", "bytes=-0"]) {
      const r = await b.call("GET", p, undefined, { range });
      assert.equal(r.status, 416, range);
      assert.equal(r.headers["content-range"], `bytes */${size}`, range);
      assert.equal(r.body.length, 0, "empty body, upstream error body not relayed");
      assert.equal(r.headers["content-type"], undefined);
      assert.match(r.headers["cache-control"], /no-store/);
    }
    assert.equal((await b.call("HEAD", p, undefined, { range: `bytes=${size}-` })).status, 416);
    // Unowned media: 404 regardless of Range; no Content-Range disclosed.
    const x = new Browser(d.port); await x.init(); await x.login(KEY_B);
    const own = await openInquiry(x);
    for (const path_ of [p, `/api/conversations/${own.id}/attachments/${up.json.attachment.id}/content`]) {
      const r = await x.call("GET", path_, undefined, { range: `bytes=${size}-` });
      assert.equal(r.status, 404); assert.equal(r.headers["content-range"], undefined);
    }
  } finally { await d.app.close(); await hg.close(); }
});

test("webhook config file: strict private format, fail closed at startup, errors never echo secrets", async () => {
  const valid = writeWebhookConfig();
  assert.deepEqual([...loadWebhookSecrets(valid).keys()].sort(), ["app_a", "app_b"]);
  const link = path.join(path.dirname(valid), "link.json");
  symlinkSync(valid, link);
  const example = writeWebhookConfig(readFileSync(path.join(ROOT_DIR, "webhook-config.example.json"), "utf8"));
  const bad = [
    writeWebhookConfig(undefined, 0o640), writeWebhookConfig(undefined, 0o604), writeWebhookConfig(undefined, 0o620),
    writeWebhookConfig({ apps: { app_a: { signingSecret: "too-short-secret" } } }),
    writeWebhookConfig({ apps: { app_a: { signingSecret: SECRET_A, hioaskKey: "x" } } }),
    writeWebhookConfig({ apps: { app_a: { signingSecret: SECRET_A } }, hioaskOrigin: "http://127.0.0.1:1" }),
    writeWebhookConfig({ apps: { "../app": { signingSecret: SECRET_A } } }),
    writeWebhookConfig({ apps: { app_a: { signingSecret: SECRET_A }, app_b: { signingSecret: SECRET_A } } }),
    writeWebhookConfig({ apps: { app_a: { signingSecret: `${SECRET_A} with space` } } }),
    writeWebhookConfig({ apps: [] }), writeWebhookConfig(`{"apps":{"app_a":{"signingSecret":"${SECRET_A}"}}`),
    link, example, "/nonexistent-inquiry-demo/webhook.json",
  ];
  for (const f of bad) {
    assert.throws(() => loadWebhookSecrets(f), (e) => e instanceof ConfigError && !e.message.includes(SECRET_A), f);
    await assert.rejects(startDemo({ webhookConfigFile: f }), ConfigError, f);
  }
  chmodSync(valid, 0o400);
  assert.equal(loadWebhookSecrets(valid).size, 2, "owner read-only is fine");
  for (const v of ["relative/webhook.json", 5, "", "/x\0y"]) assert.throws(() => validateConfig({ webhookConfigFile: v }), ConfigError);
  assert.equal(validateConfig({}).webhookConfigFile, null);
});

test("webhook secrets load at startup: signed callbacks survive restart without Key re-entry; App isolation", async () => {
  const clock = { t: Date.UTC(2026, 10, 13, 12) };
  const gateway = fakeGateway();
  const wf = writeWebhookConfig();
  const d = await startDemo({ clock, gateway, webhookConfigFile: wf });
  const b = new Browser(d.port); await b.init(); await b.login(KEY_A);
  const conv = await openInquiry(b);
  await d.app.close();
  const d2 = await startDemo({ dataDir: d.dataDir, clock, gateway, webhookConfigFile: wf });
  try {
    assert.equal(d2.app.vault.size, 0, "no Key held after restart");
    const remoteId = [...gateway.conversations.keys()][0];
    const ts = Math.floor(clock.t / 1000);
    const staff = gateway.addStaffMessage(remoteId, "Reply after Demo restart");
    const ok = await postHook(d2.port, { event_id: "evt_restart_1", type: "ask.message.created", conversation: { id: remoteId, status: "waiting_customer" }, message: staff }, SECRET_A, ts);
    assert.equal(ok.status, 200); assert.equal(ok.json.outcome, "applied");
    const foreign = await postHook(d2.port, { event_id: "evt_restart_2", type: "ask.message.created", conversation: { id: remoteId }, message: { ...staff, id: "msg_x", content: "FOREIGN" } }, SECRET_B, ts);
    assert.equal(foreign.json.outcome, "ignored", "App B secret cannot write App A conversation");
    const b2 = new Browser(d2.port, b.cookie); await b2.init();
    const s = await b2.call("GET", "/api/session");
    assert.equal(s.json.key_active, false); assert.equal(s.json.inquiry, null);
    assert.deepEqual(s.json.webhook, { status: "configured", managed_by: "hiobuy" });
    assert.ok(!s.body.toString().includes(SECRET_A));
    assert.equal((await b2.call("GET", `/api/conversations/${conv.id}/updates?since=0`)).json.error.code, "KEY_REQUIRED");
    await b2.login(KEY_A);
    const got = (await b2.call("GET", `/api/conversations/${conv.id}/updates?since=0`)).json.messages;
    assert.equal(got.find((m) => m.id === staff.id).arrival, "webhook");
    assert.ok(!got.some((m) => m.id === "msg_x"));
    for (const secret of [SECRET_A, SECRET_B]) assert.ok(!readFileSync(path.join(d.dataDir, "inquiry-demo.sqlite")).includes(Buffer.from(secret)));
    assert.ok(!gateway.calls.some((c) => c.path.includes("/webhook")));
  } finally { await d2.app.close(); }
});

test("no webhook config: hook 503 retryable, status not_configured, API reconciliation still delivers", () => withDemo(async ({ port, gateway, clock }) => {
  const b = new Browser(port); await b.init();
  const r = await b.login(KEY_A);
  assert.deepEqual(r.json.webhook, { status: "not_configured", managed_by: "hiobuy" });
  const conv = await openInquiry(b);
  const remoteId = [...gateway.conversations.keys()][0];
  const staff = gateway.addStaffMessage(remoteId, "Polled reply");
  const hook = await postHook(port, { event_id: "evt_nc", type: "ask.message.created", conversation: { id: remoteId }, message: staff }, SECRET_A, Math.floor(clock.t / 1000));
  assert.equal(hook.status, 503); assert.equal(hook.json.error.code, "WEBHOOK_NOT_CONFIGURED");
  const msgs = await b.call("GET", `/api/conversations/${conv.id}/messages`);
  assert.equal(msgs.json.messages.find((m) => m.id === staff.id).arrival, "recovered");
  assert.equal((await b.call("GET", `/api/conversations/${conv.id}/updates?since=0`)).json.webhook.status, "not_configured");
}, { webhookConfigFile: null }));
