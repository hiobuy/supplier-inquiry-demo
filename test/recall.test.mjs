import test from "node:test";
import assert from "node:assert/strict";
import { startDemo, Browser, openInquiry, request, KEY_A, SECRET_A, SECRET_B, PNG } from "./helpers.mjs";
import { signPayload } from "../src/webhook.mjs";
import { randomUUID } from "node:crypto";
import { sanitizeMessage } from "../src/handler.mjs";

function post(d, event, secret = SECRET_A) {
  const raw = Buffer.from(JSON.stringify(event));
  return request(d.port, {method:"POST",path:"/hooks/hiobuy",headers:{"content-type":"application/json","hiobuy-signature":signPayload(secret,Math.floor(d.clock.t/1000),raw)},body:raw});
}
const event = (id, type, remote, message) => ({id,type,app_id:"app_a",data:{conversation:{id:remote},message}});
const tombstone = (message) => ({...message,content:"",type:"text",attachments:[],recalled_at:"2026-11-13T12:00:01.000Z"});

test("durable recalls survive stale API/creation events, duplicates and restart", async () => {
  let d = await startDemo();
  try {
    let b = new Browser(d.port); await b.init(); await b.login(KEY_A);
    const c = await openInquiry(b), remote = [...d.gateway.conversations.keys()][0];
    const original = d.gateway.addStaffMessage(remote,"Body cached before recall");
    assert.ok((await b.call("GET",`/api/conversations/${c.id}/messages`)).json.messages.some(m=>m.content===original.content));
    const recall = event("evt_recall_1","ask.message.recalled",remote,tombstone(original));
    assert.equal((await post(d,recall)).status,200);
    assert.equal((await post(d,recall)).json.outcome,"duplicate");
    assert.equal((await post(d,{...recall,data:{...recall.data,message:{...recall.data.message,recalled_at:"2026-11-13T12:00:02.000Z"}}})).status,409);
    assert.equal((await post(d,event("evt_late_create","ask.message.created",remote,original))).status,200);
    const check = async () => {
      const page = (await b.call("GET",`/api/conversations/${c.id}/messages`)).json.messages.find(m=>m.id===original.id);
      assert.equal(page.recalled_at,recall.data.message.recalled_at); assert.equal(page.content,""); assert.deepEqual(page.attachments,[]); assert.equal(page.product_card,undefined);
      const updates = (await b.call("GET",`/api/conversations/${c.id}/updates?since=0`)).json.messages.find(m=>m.id===original.id);
      assert.equal(updates.recalled_at,page.recalled_at); assert.equal(updates.content,"");
    };
    await check();
    const cookie = b.cookie, {gateway,dataDir,clock,webhookConfigFile} = d;
    await d.app.close(); d = await startDemo({gateway,dataDir,clock,webhookConfigFile});
    b = new Browser(d.port,cookie); await b.init(); await b.login(KEY_A);
    await check();
    assert.equal((await post(d,event("evt_late_again","ask.message.created",remote,original))).status,200);
    await check();
  } finally { await d.app.close(); }
});

test("recall before creation is terminal and validates signature, scope and tombstone", async () => {
  const d = await startDemo();
  try {
    const b = new Browser(d.port); await b.init(); await b.login(KEY_A);
    const c = await openInquiry(b), remote = [...d.gateway.conversations.keys()][0];
    const original = d.gateway.addStaffMessage(remote,"Delayed creation");
    const msg = tombstone(original);
    assert.equal((await post(d,event("evt_bad_sig","ask.message.recalled",remote,msg),"wrong-secret-0123456789")).status,401);
    assert.equal((await post(d,event("evt_foreign","ask.message.recalled",remote,msg),SECRET_B)).status,403);
    for (const [i,patch] of [{id:undefined},{id:123},{recalled_at:undefined},{recalled_at:"2026-02-30T00:00:00.000Z"},{sender_type:"customer"},{conversation_id:"other"},{content:"old body"},{attachments:[{id:"old"}]},{product_card:{title:"old"}}].entries())
      assert.equal((await post(d,event(`evt_invalid_${i}`,"ask.message.recalled",remote,{...msg,...patch}))).status,400);
    assert.equal((await post(d,event("evt_first_recall","ask.message.recalled",remote,msg))).status,200);
    assert.equal((await post(d,event("evt_late_creation","ask.message.created",remote,original))).status,200);
    const page = (await b.call("GET",`/api/conversations/${c.id}/messages`)).json.messages;
    assert.equal(page.filter(m=>m.id===original.id).length,1);
    assert.equal(page.find(m=>m.id===original.id).content,"");
    assert.equal(page.find(m=>m.id===original.id).recalled_at,msg.recalled_at);
  } finally { await d.app.close(); }
});

test("API tombstones discard stale body, product card and attachments", () => {
  const m = sanitizeMessage({id:"reply_safe",sender_type:"staff",content:"old",recalled_at:"2026-11-13T12:00:01.000Z",product_card:{title:"Product",url:"https://detail.1688.com/offer/123.html"},attachments:[]},1);
  assert.equal(m.content,""); assert.equal(m.product_card,undefined); assert.deepEqual(m.attachments,[]);
  assert.equal(sanitizeMessage({...m,recalled_at:"invalid"},1),null);
});

 test("recall revokes cached attachment access even when upstream still serves it", async () => {
  const d=await startDemo();
  try {
    const b=new Browser(d.port);await b.init();await b.login(KEY_A);
    const c=await openInquiry(b),remote=[...d.gateway.conversations.keys()][0],aid=randomUUID();
    d.gateway.attachments.set(aid,{app:"app_a",type:"image/png",bytes:PNG});
    const m=d.gateway.addStaffMessage(remote,"Photo",{attachments:[{id:aid,filename:"photo.png",content_type:"image/png",size:PNG.length}]});
    const page=(await b.call("GET",`/api/conversations/${c.id}/messages`)).json;
    const contentPath=page.messages.find(x=>x.id===m.id).attachments[0].content_path;
    assert.equal((await b.call("GET",contentPath)).status,200);
    assert.equal((await post(d,event("evt_media_recall","ask.message.recalled",remote,tombstone(m)))).status,200);
    assert.equal((await b.call("GET",contentPath)).status,404);
    await b.call("GET",`/api/conversations/${c.id}/messages`);
    await post(d,event("evt_media_late","ask.message.created",remote,m));
    assert.equal((await b.call("GET",contentPath)).status,404);
  } finally {await d.app.close();}
});
