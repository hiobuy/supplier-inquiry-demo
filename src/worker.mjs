import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { CloudflareStore } from "./cloudflare-store.mjs";
import { createDemoHandler, CSP } from "./handler.mjs";
import { FixedDemoDefaults } from "./fixed-defaults.mjs";
import { handleFetch } from "./fetch-handler.mjs";

const jsonError = (status, code, message) => Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
export function productionConfig(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  const gateway = new URL(env.HIOBUY_GATEWAY_ORIGIN || "https://api.hiobuy.com");
  if (origin.origin !== env.PUBLIC_ORIGIN || origin.protocol !== "https:" || gateway.origin !== (env.HIOBUY_GATEWAY_ORIGIN || "https://api.hiobuy.com") || gateway.protocol !== "https:") throw new Error("Invalid origin");
  if (!/^app_[A-Za-z0-9_-]{1,100}$/.test(env.HIOBUY_APP_ID || "")) throw new Error("Invalid App");
  if (typeof env.HIOBUY_API_KEY !== "string" || env.HIOBUY_API_KEY.length < 16) throw new Error("Missing credential");
  return { publicOrigin: origin.origin, gatewayOrigin: gateway.origin, expectedAppId: env.HIOBUY_APP_ID,
    requireProductionKey: true, mediaEnabled: ["true", "images"].includes(env.MEDIA_ENABLED),
    videosEnabled: env.MEDIA_ENABLED === "true" };
}
function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key,value] of Object.entries({ "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer", "X-Frame-Options":"DENY",
    "Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Resource-Policy":"same-origin", "Content-Security-Policy":CSP })) headers.set(key,value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      const config = productionConfig(env), url = new URL(request.url);
      if (url.origin !== config.publicOrigin || (request.headers.has("host") && request.headers.get("host") !== url.host)) return secure(jsonError(421,"INVALID_HOST","Invalid host."));
      if (url.pathname === "/health" && request.method === "GET") return secure(Response.json({ status:"ok", service:"supplier-inquiry-demo" }));
      if (["/","/app.js","/app.css"].includes(url.pathname) && ["GET","HEAD"].includes(request.method) && !url.search) return secure(await env.ASSETS.fetch(request));
      if (!url.pathname.startsWith("/api/") && url.pathname !== "/hooks/hiobuy") return secure(jsonError(404,"NOT_FOUND","Not found."));
      return secure(await env.DEMO_STATE.getByName(config.expectedAppId).fetch(request));
    } catch {
      return secure(jsonError(503,"DEMO_NOT_CONFIGURED","The Demo is temporarily unavailable. Contact the administrator."));
    }
  },
};

/** One configured developer App; visitors remain isolated by hashed session/user ownership. */
export class DemoState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new CloudflareStore(ctx.storage);
    this.nextPurgeAt = 0;
    const config = productionConfig(env);
    const secret = env.HIOBUY_WEBHOOK_SECRET;
    if (secret !== undefined && (typeof secret !== "string" || !/^[!-~]{32,512}$/.test(secret))) throw new Error("Invalid webhook credential");
    const webhookSecrets = secret ? new Map([[config.expectedAppId,secret]]) : new Map();
    const demoDefaults = new FixedDemoDefaults(env.HIOBUY_API_KEY, { channel:env.HIOBUY_CHANNEL || "1688", id:env.HIOBUY_PRODUCT_ID, language:env.HIOBUY_PRODUCT_LANGUAGE || "en" });
    const fetchImpl = env.HIOBUY_GATEWAY ? (url,init) => env.HIOBUY_GATEWAY.fetch(new Request(url,init)) : globalThis.fetch;
    this.core = createDemoHandler({ config, store:this.store, webhookSecrets, demoDefaults, fetchImpl });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== this.env.PUBLIC_ORIGIN) return jsonError(421,"INVALID_HOST","Invalid host.");
    if (Date.now() >= this.nextPurgeAt) {
      this.nextPurgeAt = Date.now() + 60000;
      this.store.db.prepare("DELETE FROM demo_limits WHERE expires_at <= ?").run(Date.now());
      this.store.purgeSessions();
      this.core.vault.purge();
    }
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const bucket = createHash("sha256").update(this.env.HIOBUY_API_KEY + ":rate:" + ip).digest("hex");
    let retry = this.store.limit("request:"+bucket,240,60000);
    if (url.pathname === "/api/session" && !request.headers.get("cookie")?.includes("__Host-inq_sid=")) retry ||= this.store.limit("session:"+bucket,30,3600000);
    if (request.method === "POST" && url.pathname === "/api/conversations") retry ||= this.store.limit("contact:"+bucket,10,3600000);
    if (request.method === "POST" && /^\/api\/conversations\/\d+\/messages$/.test(url.pathname)) {
      retry ||= this.store.limit("messages:"+bucket,30,3600000);
      retry ||= this.store.limit("messages:global",100,86400000);
    }
    if (retry) { const response = jsonError(429,"DEMO_RATE_LIMITED","Too many requests. Please try again later."); response.headers.set("Retry-After",String(retry)); return response; }
    return handleFetch(this.core,request);
  }
}
