## Released: image-only R2 integration (2026-11-14)

Owner-approved source935d9d6 is live at100% as b5c1b0bc-ed60-4fad-9d3a-5250d2d5d74b. Existing
App,visitor namespace,credentials and Gateway binding preserved; only MEDIA_ENABLED changes to
images. Video is rejected in UI and server. HIOAsk source0a052ef,version
f3e0a415-d5bd-455d-82cd-25780b823ee1,uses owner-approved private R2 raster validation without
antivirus scanning or metadata sanitization; HIOBuy client images enabled, videos false.
42 Node+10 Worker tests pass;27 real production checks cover images in both directions, explicit
staff upload, signed recall, refresh, private notes and visitor isolation. Canonical assets match,
all3 services healthy, QA conversation closed. No production state reset or Git push.
Full evidence and limitations: ../v2-images-r2/docs/R2-IMAGES-RELEASE-2026-11-14.md.
Earlier media-disabled statements below are historical for the previous text-only release.

# Architecture

The browser renders one real product and a floating chat. It never receives an API Key.
`src/handler.mjs` owns identity/bootstrap, product lookup, conversation ownership, messages,
attachments, Webhooks, closure and rating. `src/gateway.mjs` is the HIOBuy-only HTTP client.

Two hosts share the same handler and SQLite operations:

| Host | Request adapter | Persistence |
| --- | --- | --- |
| Node 24 local | src/server.mjs | src/store.mjs, private node:sqlite file |
| Cloudflare Worker | src/worker.mjs + src/fetch-handler.mjs | src/cloudflare-store.mjs, private Durable Object SQLite |

`src/sql-store.mjs` contains the synchronous schema/queries and transactional message/event deduplication.
The Worker adapter does not open a listening port or persistent Node HTTP server.
One Durable Object is named by the configured App ID; SQL ownership additionally isolates each visitor.
Only metadata is stored. API Keys/signing secrets stay outside SQL. Hashed session IDs and rate-limit
buckets are stored; raw IPs are not. Expired sessions/rate buckets and memory credential handles are purged.
Conversation/message history is retained through deployments and browser refreshes.

The production Worker validates exact HTTPS Host/Origin, expected App and production Key environment.
Cookies are Secure/HttpOnly/SameSite=Strict with a __Host- prefix. Mutations require CSRF tokens.
Static files are allowlisted. Text uses textContent; product links and image domains are normalized.

The backend calls the public HIOBuy API by default. A same-account operator may optionally configure
HIOBUY_GATEWAY as a Worker Service Binding. The live deployment uses that internal path.
Neither route bypasses HIOBuy identity, scopes, App isolation or service enablement.

HIOAsk staff replies enter HIOBuy's signed developer Webhook pipeline. The Demo verifies raw-body HMAC,
timestamp and App ownership before applying an event transactionally. Repeated event IDs are idempotent;
conflicting bodies are rejected. Local update polling does not contact HIOBuy. Periodic message API pulls
reconcile missing events. Arrival metadata distinguishes Webhook delivery from API recovery for acceptance.

Production uses MEDIA_ENABLED=images: PNG/JPEG/WebP uploads are enabled; video is disabled in UI and server. Local image/video support and security contracts remain
available for future upstream media enablement. There is no mock runtime fallback.
