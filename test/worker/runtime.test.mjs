import { beforeEach,it,expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { SELF,reset,runInDurableObject } from 'cloudflare:test';
import { DemoState, productionConfig } from '../../src/worker.mjs';
import { signPayload } from '../../src/webhook.mjs';
const ORIGIN='https://demo.example',KEY='test-key-app-a-0123456789abcdef',SECRET='test_whsec_app_a_0123456789abcdef0123';
beforeEach(async()=>{await reset();await env.HIOBUY_GATEWAY.fetch('https://fixture.test/__fixture/reset',{method:'POST'});});
it('pins production image-only mode without enabling videos',()=>{
 expect(productionConfig({...env,MEDIA_ENABLED:'images'})).toMatchObject({mediaEnabled:true,videosEnabled:false});
 expect(productionConfig({...env,MEDIA_ENABLED:'false'})).toMatchObject({mediaEnabled:false,videosEnabled:false});
 expect(productionConfig({...env,MEDIA_ENABLED:'unexpected'})).toMatchObject({mediaEnabled:false,videosEnabled:false});
});
class Browser {
 cookie='';csrf='';
 async request(method,path,body,options={}){
  const headers={...this.cookie?{Cookie:this.cookie}:{},...method!=='GET'?{Origin:ORIGIN,'X-CSRF-Token':this.csrf,'Content-Type':'application/json'}:{},...options.headers};
  const response=await SELF.fetch(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.get('Set-Cookie'))this.cookie=response.headers.get('Set-Cookie').split(';')[0];
  const data=await response.json();
  if(data.csrf_token)this.csrf=data.csrf_token;
  return {response,data};
 }
 async bootstrap(){expect((await this.request('GET','/api/session')).response.status).toBe(200);const r=await this.request('POST','/api/bootstrap',{});expect(r.response.status,JSON.stringify(r.data)).toBe(200);this.csrf=r.data.session.csrf_token;return r.data;}
 async contact(){const r=await this.request('POST','/api/conversations',{slot:'1688:673124809943'});expect(r.response.status,JSON.stringify(r.data)).toBe(200);return r.data.conversation;}
}
it('runs the shared Node HTTP handler on real Worker SQL with secure cookies and pinned identity',async()=>{
 expect(env.PUBLIC_ORIGIN).toBe(ORIGIN);
 const b=new Browser();const first=await b.request('GET','/api/session');expect(first.response.status,JSON.stringify(first.data)).toBe(200);expect(first.response.headers.get('Set-Cookie')).toContain('Secure');expect(b.cookie.startsWith('__Host-inq_sid=')).toBe(true);
 const result=await b.bootstrap();expect(result.session.app.id).toBe('app_a');expect(result.session.media_enabled).toBe(false);expect(result.product.slot).toBe('1688:673124809943');expect(JSON.stringify(result)).not.toContain(KEY);
});
it('rejects wrong hosts, cross-origin mutations, missing CSRF and arbitrary product selection',async()=>{
 expect((await SELF.fetch('https://evil.example/api/session')).status).toBe(421);
 const b=new Browser();await b.bootstrap();expect((await b.request('POST','/api/bootstrap',{}, {headers:{Origin:'https://evil.example'}})).response.status).toBe(403);
 expect((await b.request('POST','/api/bootstrap',{}, {headers:{'X-CSRF-Token':'wrong'}})).response.status).toBe(403);
 expect((await b.request('POST','/api/conversations',{slot:'1688:123'})).response.status).toBe(400);
});
it('resumes one conversation and isolates visitors; media is explicitly disabled',async()=>{
 const b=new Browser();await b.bootstrap();const c=await b.contact();expect((await b.contact()).id).toBe(c.id);
 const other=new Browser();await other.bootstrap();expect((await other.request('GET','/api/conversations/'+c.id)).response.status).toBe(404);
 const r=await b.request('POST',`/api/conversations/${c.id}/attachments?upload_id=${crypto.randomUUID()}`,{});expect(r.response.status).toBe(503);expect(r.data.error.code).toBe('MEDIA_DISABLED');
});
it('sends text idempotently, reconstructs persistent state, verifies signed webhook delivery and deduplication',async()=>{
 const b=new Browser();await b.bootstrap();const c=await b.contact();const cmid=crypto.randomUUID();
 const first=await b.request('POST',`/api/conversations/${c.id}/messages`,{client_message_id:cmid,content:'  real-contract text\n'});expect(first.response.status,JSON.stringify(first.data)).toBe(200);
 const again=await b.request('POST',`/api/conversations/${c.id}/messages`,{client_message_id:cmid,content:'  real-contract text\n'});expect(again.data.message.id).toBe(first.data.message.id);
 const actor=env.DEMO_STATE.getByName('app_a');
 const remote=await runInDurableObject(actor,(instance)=>instance.store.db.prepare('SELECT hioask_id FROM conversations WHERE id=?').get(c.id).hioask_id);
 await runInDurableObject(actor,(instance,state)=>{
  const replacement=new DemoState(state,env);instance.core.close();instance.core=replacement.core;instance.store=replacement.store;
 });
 expect((await b.bootstrap()).conversation.id).toBe(c.id);
 const event={id:'evt_worker_fixture',type:'ask.message.created',app_id:'app_a',data:{conversation:{id:remote,status:'waiting_customer'},message:{id:'reply_worker_1',conversation_id:remote,sender_type:'staff',content:'Signed staff reply',original_content:'PRIVATE',type:'text',created_at:new Date().toISOString()}}};
 const raw=Buffer.from(JSON.stringify(event)),signature=signPayload(SECRET,Math.floor(Date.now()/1000),raw);
 const hook=()=>SELF.fetch(ORIGIN+'/hooks/hiobuy',{method:'POST',headers:{'Content-Type':'application/json','HioBuy-Signature':signature},body:raw});
 expect((await hook()).status).toBe(200);expect((await hook()).status).toBe(200);
 const updates=await b.request('GET',`/api/conversations/${c.id}/updates?since=0`);const replies=updates.data.messages.filter(m=>m.id==='reply_worker_1');expect(replies).toHaveLength(1);expect(replies[0].arrival).toBe('webhook');expect(JSON.stringify(replies)).not.toContain('PRIVATE');
 const stored=await runInDurableObject(actor,(_instance,state)=>state.storage.sql.exec("SELECT * FROM messages").toArray());expect(JSON.stringify(stored)).not.toContain(KEY);expect(JSON.stringify(stored)).not.toContain(SECRET);
});
it('fails closed on unsigned callbacks and rate-limits unauthenticated session creation',async()=>{
 expect((await SELF.fetch(ORIGIN+'/hooks/hiobuy',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
 for(let i=0;i<30;i++)expect((await SELF.fetch(ORIGIN+'/api/session')).status).toBe(200);
 expect((await SELF.fetch(ORIGIN+'/api/session')).status).toBe(429);
});
it('rejects a configured Key from another App before binding or product access',async()=>{
 const actor=env.DEMO_STATE.getByName('app_a');
 await runInDurableObject(actor,(instance,state)=>{const replacement=new DemoState(state,{...env,HIOBUY_APP_ID:'app_other'});instance.core.close();instance.core=replacement.core;instance.store=replacement.store;});
 const b=new Browser();await b.request('GET','/api/session');const result=await b.request('POST','/api/bootstrap',{});
 expect(result.response.status).toBe(503);expect(result.data.error.code).toBe('CONFIGURED_APP_MISMATCH');
 const rows=await runInDurableObject(actor,(instance)=>instance.store.db.prepare('SELECT app_id FROM sessions').all());expect(rows.every(r=>r.app_id===null)).toBe(true);
});
it('rejects test-Key identity for the production demo',async()=>{
 const actor=env.DEMO_STATE.getByName('app_a');
 await runInDurableObject(actor,(instance,state)=>{
  const binding={fetch:async(request)=>{const response=await env.HIOBUY_GATEWAY.fetch(request);const data=await response.json();if(new URL(request.url).pathname==='/v1/ask/identity')data.data.api_key.environment='sandbox';return Response.json(data,{status:response.status});}};
  const replacement=new DemoState(state,{...env,HIOBUY_GATEWAY:binding});instance.core.close();instance.core=replacement.core;instance.store=replacement.store;
 });
 const b=new Browser();await b.request('GET','/api/session');const r=await b.request('POST','/api/bootstrap',{});expect(r.response.status).toBe(503);expect(r.data.error.code).toBe('PRODUCTION_KEY_REQUIRED');
});
it('keeps closure terminal when an older signed status event arrives later',async()=>{
 const visitor=new Browser();await visitor.bootstrap();const conversation=await visitor.contact();
 const actor=env.DEMO_STATE.getByName('app_a');
 const remote=await runInDurableObject(actor,instance=>instance.store.db.prepare('SELECT hioask_id FROM conversations WHERE id=?').get(conversation.id).hioask_id);
 for(const status of ['closed','waiting_customer']){
  const raw=Buffer.from(JSON.stringify({id:'evt_order_'+status,type:status==='closed'?'ask.conversation.closed':'ask.conversation.updated',app_id:'app_a',data:{conversation:{id:remote,status}}}));
  const signature=signPayload(SECRET,Math.floor(Date.now()/1000),raw);
  expect((await SELF.fetch(ORIGIN+'/hooks/hiobuy',{method:'POST',headers:{'Content-Type':'application/json','HioBuy-Signature':signature},body:raw})).status).toBe(200);
 }
 expect((await visitor.request('GET','/api/conversations/'+conversation.id)).data.conversation.status).toBe('closed');
});
it('persists recall-before-creation tombstones across existing Worker SQL reconstruction',async()=>{
 const b=new Browser();await b.bootstrap();const c=await b.contact();
 const actor=env.DEMO_STATE.getByName('app_a');
 const remote=await runInDurableObject(actor,instance=>instance.store.db.prepare('SELECT hioask_id FROM conversations WHERE id=?').get(c.id).hioask_id);
 const original={id:'reply_recall_worker',conversation_id:remote,sender_type:'staff',type:'text',content:'Late original body',created_at:new Date().toISOString()};
 const post=async(id,type,message)=>{
  const raw=Buffer.from(JSON.stringify({id,type,app_id:'app_a',data:{conversation:{id:remote},message}}));
  return SELF.fetch(ORIGIN+'/hooks/hiobuy',{method:'POST',headers:{'Content-Type':'application/json','HioBuy-Signature':signPayload(SECRET,Math.floor(Date.now()/1000),raw)},body:raw});
 };
 const recalled={...original,content:'',recalled_at:new Date().toISOString()};
 expect((await post('evt_worker_recall','ask.message.recalled',recalled)).status).toBe(200);
 expect((await post('evt_worker_recall','ask.message.recalled',recalled)).status).toBe(200);
 await runInDurableObject(actor,(instance,state)=>{const replacement=new DemoState(state,env);instance.core.close();instance.core=replacement.core;instance.store=replacement.store;});
 expect((await post('evt_worker_late_create','ask.message.created',original)).status).toBe(200);
 await b.bootstrap();
 const check=async()=>{
  const updates=(await b.request('GET',`/api/conversations/${c.id}/updates?since=0`)).data;
  const message=updates.messages.find(m=>m.id===original.id);
  expect(message.content).toBe('');expect(message.recalled_at).toBe(recalled.recalled_at);expect(message.attachments).toEqual([]);
 };
 await check();
 await b.request('GET',`/api/conversations/${c.id}/messages`);await check();
});
