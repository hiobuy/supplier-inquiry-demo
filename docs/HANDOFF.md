# Recall trial published (2026-11-14)

Owner approved publishing for use. Source8008985 is deployed as
b9780abb-5425-479d-8f72-9c7a9e75c120,100% traffic. Existing12 binding definitions,production secrets,
fixed App,private DO namespace,visitor history and media-disabled policy are preserved. The existing
HIOBuy endpoint retains3 original subscriptions and adds ask.message.recalled. Only this supported
HIOAsk App is opted in. No new resource or credential rotation.

Actual production signing,immediate direct-send/native scheduling,real recall,Demo Webhook-cache
arrival,placeholder,refresh and390px browser checks passed as part of15 integrated production checks.
Observed publication1291ms;the QA inquiry was closed. No paid translation,supplier contact or old
visitor mutation. Canonical JS/CSS hashes match this candidate. Private evidence remains in the
isolated dashboard .local/releases/recall-2026-11-14/. Full release report is the dashboard's
docs/RECALL-PRODUCTION-RELEASE-2026-11-14.md. No Git push/merge or further rollout;await user feedback.
The earlier local-only release gate below is superseded for this completed trial.

# Local recall increment (2026-11-14)

The isolated `codex/message-recall` worktree now accepts ask.message.recalled and persists terminal
message tombstones in the existing shared SQLite cache. Browser merging and rendering preserve
recalls across stale responses, duplicates, navigation, polling and refresh. Former attachment
access is revoked locally. See RECALL-ACCEPTANCE.md for fixtures, browser evidence and release gate.

This is local source only. The live version/history, production secrets, existing DO namespace and
original main checkout are unchanged. Do not change the production endpoint subscription or enable
HIOAsk recall without final owner release authorization. Older historical records follow.

# Core handoff

Updated 2026-11-13. This is the recovery entry point; inspect Git status and this file before continuing.

## Runtime

- Live origin: https://inquiry.demo.hiobuy.com
- Worker: hiobuy-supplier-inquiry-demo
- Fixed App: app_3e7f56973f47ee3e53303614, production Key only.
- Product: 1688 / 673124809943 / en.
- HIOBuy Gateway via Worker Service Binding; generic self-host config uses public HTTPS.
- Private Durable Object SQLite persists history. Secrets: HIOBUY_API_KEY and HIOBUY_WEBHOOK_SECRET.
- HIOBuy developer endpoint: /hooks/hiobuy, three ask.* events. No HIOAsk integration credentials here.
- Production media disabled; text + upstream real translation enabled.

## Verification

35 Node contract/security/client tests and 8 Worker runtime/SQL tests passed. These use fixtures.
A clean npm ci plus both suites also passed without local credentials.
Real production product loading, App identity, conversation creation, customer send, staff claim,
automatic translated reply, signed HIOBuy Webhook reception and post-deployment refresh recovery passed.
The Webhook assertion read only local updates, without the message API, and observed arrival=webhook.
Real failure recovery also passed: a temporary same-origin unavailable callback returned HTTP 404,
and the missing reply was recovered through the message API with arrival=recovered. The normal callback
URL and signing secret are restored. Invalid Key 401, cross-App/visitor 404, unsigned hook 401 and
disabled media 503 passed. The test conversation closed, received a 5-star rating, and remained closed
with its submitted rating after bootstrap. A separate live browser test also loaded the real product, sent a message, restored history after
refresh, displayed the automatic translated support reply, closed the conversation and submitted 5 stars.
No real supplier was contacted; all QA content identifies
itself as an internal Inquiry Demo test.

Live Demo code version: bc71a993-74cc-4982-9f2c-8f2c4f86c087 (header repository link, 2026-11-13).
The earlier full integration acceptance used version 1cc7a8f2-f41d-44e8-9b1f-bacc166e50f5.
The backend prevents delayed status events from reopening a closed conversation;
a signed out-of-order event regression passed.
HIOBuy integration fixes are released and pushed on its main branch. Its 132 bindings and Portal
AI/product flags are unchanged. No new migration or capability grant was required.

Public repository: https://github.com/hiobuy/supplier-inquiry-demo, main. It starts with a clean source
snapshot; earlier internal development history is retained on the local codex/inquiry-demo branch.
Private state and operational records remain ignored. The release credential-byte scan found no real
secrets in the public snapshot; four Gitleaks findings are reviewed synthetic test literals.

## UI refresh (2026-11-13)

- Added a compact GitHub source link in the page header, opening the public repository in a new tab.
  The production link and 320px mobile layout were verified; all 43 existing fixture tests passed.
- Refined the product gallery, typography, inquiry action and floating chat launcher.
- Mobile chat has a single-row header and full-screen layout with visual viewport/safe-area handling.
  The duplicate product header and external product links inside chat were removed; the product page
  retains its original-listing link. End chat sits below the composer.
- Added draft-only suggested questions, expanding input, unread counts and a jump-to-new-messages
  control. Existing inquiry, attachment policy, Webhook/API synchronization, closure and rating
  contracts are unchanged. Mobile Enter inserts a newline; the send button submits.
- Added a two-note reply chime and a mute toggle. Audio starts after a visitor interaction, subject
  to browser audio policy. History loading, older-page loading and duplicate reconciliation stay silent.
- All 35 Node and 8 Worker fixture tests passed, including three notification regressions.
  Isolated browser QA covered 320px/390px layouts, failed send/retry without duplicates, a signed
  fixture reply, unread recovery, history refresh, closure, rating and a new inquiry.
- Production smoke checks verified health 200, all three deployed asset hashes, real product loading,
  existing conversation history, the compact mobile header and the sound toggle. No new production
  message, closure or rating was submitted for this UI release. No backend, secret, namespace or
  migration changes were made.

## Recovery rules

Preserve the Worker name/namespace and SQLite data. After changing secrets, deploy and re-bootstrap;
verified credential handles are memory-only and must be revalidated after a restart. Browser bootstrap
performs that automatically. Never replace real API errors with fake replies or create duplicate inquiries
when resuming. Keep private credentials, browser sessions and operational test reports out of Git.
Local Node previews and private history are independent and must not be reset for a deployment.
