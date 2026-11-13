import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FixedDemoDefaults,
  loadFixedDemoDefaults,
  DefaultsError,
} from "../src/defaults.mjs";
import {
  startDemo,
  Browser,
  KEY_A,
  KEY_NOSCOPE,
  SAMPLE_ID,
  openInquiry,
} from "./helpers.mjs";
const fixed = (key) =>
  new FixedDemoDefaults(key, { channel: "1688", id: SAMPLE_ID });
test("private defaults require valid product and private regular file; errors never echo credentials", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inquiry-defaults-")),
    file = path.join(dir, ".dev.vars");
  const content = `HIOBUY_API_KEY="${KEY_A}"\nHIOBUY_CHANNEL=1688\nHIOBUY_PRODUCT_ID=${SAMPLE_ID}\n`;
  writeFileSync(file, content, { mode: 0o600 });
  const config = loadFixedDemoDefaults(file);
  assert.equal(config.getKey(), KEY_A);
  assert.equal(config.product.slot, `1688:${SAMPLE_ID}`);
  assert(!JSON.stringify(config).includes(KEY_A));
  chmodSync(file, 0o644);
  assert.throws(() => loadFixedDemoDefaults(file), DefaultsError);
  chmodSync(file, 0o600);
  const link = path.join(dir, "link");
  symlinkSync(file, link);
  assert.throws(() => loadFixedDemoDefaults(link), DefaultsError);
  for (const bad of [
    content + "HIOBUY_API_KEY=another-key\n",
    content.replace(SAMPLE_ID, "bad-id"),
    content.replace("1688", "evil"),
    content.replace(KEY_A, "bad"),
  ]) {
    writeFileSync(file, bad);
    assert.throws(
      () => loadFixedDemoDefaults(file),
      (e) => e instanceof DefaultsError && !e.message.includes(KEY_A),
    );
  }
});
test("fixed bootstrap loads real-contract product without browser key, enforces configured product and restores history after restart", async (t) => {
  let d = await startDemo({ demoDefaults: fixed(KEY_A) });
  t.after(() => d.app.close());
  let b = new Browser(d.port);
  await b.init();
  let r = await b.call("POST", "/api/bootstrap", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.product.product_id, SAMPLE_ID);
  assert.equal(r.json.conversation, null);
  assert(!r.body.includes(KEY_A));
  assert.equal((await b.login(KEY_A)).status, 404);
  assert.equal(
    (
      await b.call("POST", "/api/products/lookup", {
        channel: "1688",
        value: "123456",
      })
    ).status,
    403,
  );
  assert.equal(
    (await b.call("POST", "/api/conversations", { slot: "1688:123456" }))
      .status,
    403,
  );
  r = await b.call("POST", "/api/conversations", { slot: `1688:${SAMPLE_ID}` });
  const c = r.json.conversation;
  assert(c.ready);
  const sent = await b.call("POST", `/api/conversations/${c.id}/messages`, {
    client_message_id: randomUUID(),
    content: "  exact original\n",
  });
  assert.equal(sent.status, 200);
  const cookie = b.cookie;
  const { gateway, dataDir, clock } = d;
  await d.app.close();
  d = await startDemo({ demoDefaults: fixed(KEY_A), gateway, dataDir, clock });
  b = new Browser(d.port, cookie);
  await b.init();
  r = await b.call("POST", "/api/bootstrap", {});
  assert.equal(r.json.conversation.id, c.id);
  assert.equal(
    (await b.call("GET", `/api/conversations/${c.id}/messages`)).json
      .messages[0].content,
    "  exact original\n",
  );
  const db = readFileSync(path.join(dataDir, "inquiry-demo.sqlite"));
  assert(!db.includes(KEY_A));
  const html = (await b.call("GET", "/")).body.toString();
  assert(!/key-input|product-form|<select/.test(html));
  const js = (await b.call("GET", "/app.js")).body.toString();
  assert(!js.includes(KEY_A));
  assert(
    !/localStorage|sessionStorage|simulateReplies|inquiry-config/.test(js),
  );
});
test("default key with missing inquiry scope still loads product and cannot create real chat", async (t) => {
  const d = await startDemo({ demoDefaults: fixed(KEY_NOSCOPE) });
  t.after(() => d.app.close());
  const b = new Browser(d.port);
  await b.init();
  const r = await b.call("POST", "/api/bootstrap", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.product.product_id, SAMPLE_ID);
  assert.equal(r.json.session.inquiry.write, false);
  assert.equal(
    (await b.call("POST", "/api/conversations", { slot: `1688:${SAMPLE_ID}` }))
      .status,
    403,
  );
  assert.equal(d.gateway.conversations.size, 0);
});
test("configured mode hides and rejects previous product conversations", async (t) => {
  let d = await startDemo();
  t.after(() => d.app.close());
  let b = new Browser(d.port);
  await b.init();
  await b.login(KEY_A);
  const other = await openInquiry(b, "123456");
  const cookie = b.cookie;
  const { gateway, dataDir, clock } = d;
  await d.app.close();
  d = await startDemo({ demoDefaults: fixed(KEY_A), gateway, dataDir, clock });
  b = new Browser(d.port, cookie);
  await b.init();
  await b.call("POST", "/api/bootstrap", {});
  assert.equal(
    (await b.call("GET", `/api/conversations/${other.id}`)).status,
    404,
  );
  assert.deepEqual(
    (await b.call("GET", "/api/conversations")).json.conversations,
    [],
  );
});
