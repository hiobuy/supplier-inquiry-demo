import { test } from "node:test";
import assert from "node:assert/strict";
import util from "node:util";
import { KeyVault, KEY_TTL_MS } from "../src/keyvault.mjs";
import { parseProductInput, normalizeProduct, safeImageUrl } from "../src/product.mjs";
import { verifySignature, signPayload, parseEvent } from "../src/webhook.mjs";
import { sanitizeMessage } from "../src/server.mjs";
import { validateConfig } from "../src/config.mjs";
import { sanitizeMessage as sanitizeGatewayMessage, GatewayClient } from "../src/gateway.mjs";

test("KeyVault: hard TTL, no extension, no serialization leaks", () => {
  let t = 1000;
  const v = new KeyVault({ now: () => t });
  const exp = v.set("h1", "secret-key-value-123456", "app_a");
  assert.equal(exp, 1000 + KEY_TTL_MS);
  t += KEY_TTL_MS - 1;
  assert.equal(v.get("h1").apiKey, "secret-key-value-123456");
  assert.equal(v.get("h1").expiresAt, exp, "reads never extend TTL");
  t += 1;
  assert.equal(v.get("h1"), null);
  v.set("h2", "another-secret-key-000000", "app_b");
  t += KEY_TTL_MS;
  v.purge();
  assert.equal(v.size, 0);
  v.set("h3", "leak-check-secret-0000000", "app_b");
  assert.ok(!JSON.stringify(v).includes("leak-check"));
  assert.ok(!util.inspect(v, { depth: 10 }).includes("leak-check"));
  assert.throws(() => new KeyVault({ ttlMs: KEY_TTL_MS + 1 }));
});

test("product input: official URLs and numeric IDs only", () => {
  assert.deepEqual(parseProductInput({ value: "https://detail.1688.com/offer/554456348334.html?spm=x" }),
    { channel: "1688", id: "554456348334", slot: "1688:554456348334", url: "https://detail.1688.com/offer/554456348334.html", language: "en" });
  assert.equal(parseProductInput({ value: "554456348334", channel: "1688" }).slot, "1688:554456348334");
  assert.equal(parseProductInput({ value: "https://detail.tmall.com/item.htm?id=123456789&x=1" }).url, "https://detail.tmall.com/item.htm?id=123456789");
  assert.equal(parseProductInput({ value: "https://item.taobao.com/item.htm?id=123456789", language: "cn" }).channel, "taobao");
  for (const bad of [
    { value: "http://detail.1688.com/offer/554456348334.html" },
    { value: "https://detail.1688.com.evil.com/offer/554456348334.html" },
    { value: "https://user:pw@detail.1688.com/offer/554456348334.html" },
    { value: "https://detail.1688.com:444/offer/554456348334.html" },
    { value: "554456348334" },
    { value: "https://detail.1688.com/offer/554456348334.html", channel: "taobao" },
    { value: "https://detail.1688.com/offer/554456348334.html", language: "cn" },
    { value: "javascript:alert(1)" },
  ]) assert.throws(() => parseProductInput(bad), undefined, JSON.stringify(bad));
});

test("product normalization: approved CDN only, canonical URL, no invented details", () => {
  const parsed = parseProductInput({ value: "554456348334", channel: "1688" });
  const p = normalizeProduct({ data: { product: { title: { translated: "Bag <b>x</b>" }, image: "//img.alicdn.com/a.png",
    images: [{ url: "https://evil.com/a.jpg" }, { url: "https://cbu01.alicdn.com:8443/a.jpg" }, "https://cbu01.alicdn.com/b.jpg"],
    price: { original_amount: "12", original_currency: "CNY" }, source_url: "https://evil.com" }, request_id: "r1" } }, parsed);
  assert.deepEqual(p.images, ["https://img.alicdn.com/a.png", "https://cbu01.alicdn.com/b.jpg"]);
  assert.equal(p.url, "https://detail.1688.com/offer/554456348334.html");
  assert.equal(p.price_label, null, "non-numeric price omitted");
  assert.equal(p.title, "Bag <b>x</b>", "title kept as plain text for textContent rendering");
  assert.equal(normalizeProduct({ product: {} }, parsed), null);
  assert.equal(safeImageUrl("https://alicdn.com.evil.net/a.jpg"), null);
});

test("product images: exact global-img-cdn.1688.com allowed; other 1688 hosts and lookalikes denied", () => {
  const real = "https://global-img-cdn.1688.com/img/ibank/O1CN01YemWFE1m2PthVBD8S_!!2209670674896-0-cib.jpg";
  assert.equal(safeImageUrl(real), real);
  assert.equal(safeImageUrl("//global-img-cdn.1688.com/img/a.png"), "https://global-img-cdn.1688.com/img/a.png");
  assert.equal(safeImageUrl("https://global-img-cdn.1688.com/img/a.jpg_.webp"), "https://global-img-cdn.1688.com/img/a.jpg_.webp");
  for (const bad of [
    "http://global-img-cdn.1688.com/img/a.jpg",
    "https://global-img-cdn.1688.com.evil.com/img/a.jpg",
    "https://evil-global-img-cdn.1688.com/img/a.jpg",
    "https://x.global-img-cdn.1688.com/img/a.jpg",
    "https://img.1688.com/img/a.jpg",
    "https://cbu01.1688.com/img/a.jpg",
    "https://detail.1688.com/img/a.jpg",
    "https://1688.com/img/a.jpg",
    "https://global-img-cdn.1688.com:8443/img/a.jpg",
    "https://user:pw@global-img-cdn.1688.com/img/a.jpg",
    "https://global-img-cdn.1688.com/img/a.svg",
    "https://global-img-cdn.1688.com/img/a.gif",
    "https://global-img-cdn.1688.com/",
    "https://global-img-cdn.1688.com%2eevil.com/a.jpg",
  ]) assert.equal(safeImageUrl(bad), null, bad);
});

test("webhook signature: exact raw body, window, multi-App selection", () => {
  const body = Buffer.from('{"event_id":"evt_1","type":"ask.message.created"}');
  const now = 1_800_000_000;
  const cands = [{ appId: "app_a", secret: "secret_a_0123456789" }, { appId: "app_b", secret: "secret_b_0123456789" }];
  const sig = signPayload("secret_b_0123456789", now, body);
  assert.deepEqual(verifySignature(sig, body, cands, now), { ok: true, appId: "app_b", timestamp: now });
  assert.equal(verifySignature(sig, Buffer.from(body.toString() + " "), cands, now).reason, "SIGNATURE_INVALID");
  assert.equal(verifySignature(sig, body, cands, now + 301).reason, "SIGNATURE_EXPIRED");
  assert.equal(verifySignature(sig, body, cands, now - 301).reason, "SIGNATURE_EXPIRED");
  assert.equal(verifySignature(signPayload("wrong_secret_000000", now, body), body, cands, now).reason, "SIGNATURE_INVALID");
  assert.equal(verifySignature("v1=abc", body, cands, now).reason, "SIGNATURE_MALFORMED");
  assert.equal(verifySignature(undefined, body, cands, now).reason, "SIGNATURE_MISSING");
  assert.equal(parseEvent({ event_id: "../x", type: "ask.message.created" }), null);
  assert.equal(parseEvent({ id: "evt_2", type: "ask.message.created", data: { message: { id: "m" } } }).message.id, "m");
});

test("message sanitization: allowlist, local content paths, approved product card", () => {
  const m = sanitizeMessage({ id: "msg_1", conversation_id: "c1", client_message_id: "x", type: "text", content: "hi", sender_type: "staff",
    created_at: "2026-11-13T00:00:00Z", staff_name: "Alice", original_text: "secret",
    attachments: [{ id: "11111111-1111-4111-8111-111111111111", filename: "a.png", content_type: "image/png", size: 1, width: 1, height: 1, content_path: "https://evil/x", bucket_key: "k" },
      { id: "x", content_type: "text/html" }],
    product_card: { url: "https://evil.com/offer/1.html", title: "t" } }, 7);
  assert.equal(m.staff_name, undefined);
  assert.equal(m.original_text, undefined);
  assert.equal(m.product_card, undefined);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].content_path, "/api/conversations/7/attachments/11111111-1111-4111-8111-111111111111/content");
  assert.equal(m.attachments[0].bucket_key, undefined);
  assert.equal(sanitizeMessage({ id: "msg_2", sender_type: "system" }, 7), null);
});

test("config: no key fields, fixed loopback/https gateway origin", () => {
  assert.throws(() => validateConfig({ apiKey: "x" }));
  assert.throws(() => validateConfig({ hioaskApiKey: "x" }));
  assert.throws(() => validateConfig({ gatewayOrigin: "http://example.com" }));
  assert.throws(() => validateConfig({ gatewayOrigin: "http://127.0.0.1:18802/path" }));
  assert.equal(validateConfig({}).gatewayOrigin, "https://api.hiobuy.com");
  assert.throws(() => validateConfig({ webhookSigningSecret: "x" }), "secrets never inline in config");
  assert.throws(() => validateConfig({ webhookConfigFile: "relative.json" }));
  assert.equal(validateConfig({ webhookConfigFile: "/tmp/x/../wh.json" }).webhookConfigFile, "/tmp/wh.json");
});

test("client image allowlist mirrors server (static check of public/app.js and CSP)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(src.includes('x.hostname === "global-img-cdn.1688.com"'), "exact host comparison in client");
  assert.ok(!/1688\\\.com\$\//.test(src), "no *.1688.com wildcard in client");
  const server = readFileSync(new URL("../src/handler.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("img-src 'self' https://*.alicdn.com https://global-img-cdn.1688.com;"));
  assert.ok(!server.includes("https://*.1688.com"));
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!html.includes("key-input") && !html.includes("product-value"));
});

test("gateway client: redacts key from upstream errors, no redirects, unavailable mapping", async () => {
  assert.ok(!sanitizeGatewayMessage("bad key sk_live_abcdefghijklmnop", []).includes("abcdefghijklmnop"));
  const key = "custom-key-material-000000000";
  let seen;
  const client = new GatewayClient({ origin: "http://127.0.0.1:1", fetchImpl: async (url, init) => { seen = init; return new Response(JSON.stringify({ error: { code: "INVALID_API_KEY", message: `bad ${key}` } }), { status: 401 }); } });
  await assert.rejects(client.identity(key), (e) => e.status === 401 && e.code === "INVALID_API_KEY" && !e.message.includes(key));
  assert.equal(seen.redirect, "manual");
  const down = new GatewayClient({ origin: "http://127.0.0.1:1", fetchImpl: async () => { throw new TypeError("x"); } });
  await assert.rejects(down.identity(key), (e) => e.status === 503 && e.code === "GATEWAY_UNAVAILABLE");
  const redir = new GatewayClient({ origin: "http://127.0.0.1:1", fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://evil" } }) });
  await assert.rejects(redir.identity(key), (e) => e.code === "GATEWAY_REDIRECT_REJECTED");
  const err500 = new GatewayClient({ origin: "http://127.0.0.1:1", fetchImpl: async () => new Response(JSON.stringify({ error: { code: "X", message: "stack trace at /srv" } }), { status: 500 }) });
  await assert.rejects(err500.identity(key), (e) => e.status === 502 && e.message === "Gateway request failed.");
});
