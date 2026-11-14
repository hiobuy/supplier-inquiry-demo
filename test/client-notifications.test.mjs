import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
// Exercise the real client functions without browser event wiring or a live API.
const functions = source.slice(
  0,
  source.indexOf('\n$("contact").addEventListener'),
);
function client({ audioAvailable = true, blocked = false } = {}) {
  const tones = [],
    nodes = new Map();
  let clock = 5000;
  class AudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      if (blocked) throw new Error("Browser policy");
    }
    createOscillator() {
      return {
        frequency: {},
        connect() {},
        disconnect() {},
        start: () => tones.push(clock),
        stop() {},
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    }
  }
  const context = vm.createContext({
    window: {
      matchMedia: () => ({ matches: false }),
      ...(audioAvailable ? { AudioContext } : {}),
    },
    document: {
      getElementById(id) {
        if (!nodes.has(id))
          nodes.set(id, { hidden: true, textContent: "", setAttribute() {} });
        return nodes.get(id);
      },
    },
    performance: { now: () => clock },
  });
  vm.runInContext(functions, context);
  return {
    tones,
    run: (code) => vm.runInContext(code, context),
    merge: (messages, options = {}) => {
      context.incoming = messages;
      context.options = options;
      return vm.runInContext("mergeMessages(incoming, options)", context);
    },
    advance: () => {
      clock += 2000;
    },
  };
}
const reply = (id, extra = {}) => ({
  id,
  sender_type: "staff",
  seq: 1,
  ...extra,
});

test("reply sound is silent for restored/older history, customer messages, and duplicate reconciliation", () => {
  const c = client();
  c.run("unlockReplySound()");
  c.merge([reply("restored")]);
  assert.equal(c.tones.length, 0);
  c.run("state.historyReady = true");
  c.merge([reply("restored", { seq: 2, arrival: "webhook" })]);
  c.merge([reply("customer", { sender_type: "customer" })]);
  c.merge([reply("older")], { historical: true });
  assert.equal(c.tones.length, 0);
  assert.equal(c.run("state.unread.size"), 0);
  c.merge([reply("new"), reply("another-new")]);
  assert.equal(
    c.tones.length,
    2,
    "one two-note notification for a batch of new replies",
  );
  assert.equal(c.run("state.unread.size"), 2);
  c.advance();
  c.merge([reply("new", { seq: 3, webhook_confirmed: true })]);
  assert.equal(
    c.tones.length,
    2,
    "API/Webhook reconciliation never repeats the sound",
  );
});

test("reply sound respects mute and requires browser audio to be unlocked", () => {
  const c = client();
  c.run("state.historyReady = true");
  c.merge([reply("before-gesture")]);
  assert.equal(c.tones.length, 0);
  c.run("unlockReplySound(); state.soundEnabled = false");
  c.merge([reply("muted")]);
  assert.equal(c.tones.length, 0);
  c.run("state.soundEnabled = true; unlockReplySound()");
  c.merge([reply("audible")]);
  assert.equal(c.tones.length, 2);
});

test("unsupported or blocked audio never prevents a reply from rendering", () => {
  for (const options of [{ audioAvailable: false }, { blocked: true }]) {
    const c = client(options);
    c.run("unlockReplySound(); state.historyReady = true");
    assert.equal(c.merge([reply("reply")]), true);
    assert.equal(c.run("state.messages.size"), 1);
    assert.equal(c.tones.length, 0);
  }
});

test("recall is terminal in the browser and never adds sound or unread replies", () => {
  const c = client(); c.run("unlockReplySound(); state.historyReady = true");
  c.merge([reply("first",{recalled_at:"2026-11-13T12:00:00.000Z",content:""})]);
  assert.equal(c.tones.length,0); assert.equal(c.run("state.unread.size"),0);
  c.merge([reply("first",{seq:99,content:"late original"})]);
  assert.equal(c.run('state.messages.get("first").content'),"");
  c.merge([reply("normal",{content:"new reply"})]);
  assert.equal(c.tones.length,2); assert.equal(c.run("state.unread.size"),1);
  c.merge([reply("normal",{recalled_at:"2026-11-13T12:00:00.000Z",content:""})]);
  assert.equal(c.run("state.unread.size"),0); assert.equal(c.tones.length,2);
  c.merge([reply("normal",{seq:100,content:"stale response"})]);
  assert.equal(c.run('state.messages.get("normal").content'),"");
});

 test("responses from a prior visit cannot resurrect messages after A to B to A navigation", async () => {
  for (const method of ["reconcile(false)","pollUpdates()"]){
    const c=client();
    c.run('state.current={id:"a"}; state.viewEpoch=1; let release; api=()=>new Promise(resolve=>{release=resolve})');
    const pending=c.run(method);
    c.run('state.current={id:"b"}; state.viewEpoch++; state.current={id:"a"}; state.viewEpoch++; release({messages:[{id:"old",sender_type:"staff",content:"late original"}],seq:10})');
    await pending;
    assert.equal(c.run('state.messages.size'),0);
    assert.equal(c.run('state.seq'),0);
  }
});
