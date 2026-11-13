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

32 Node contract/security tests and 8 Worker runtime/SQL tests passed. These use fixtures.
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

Live Demo code version: 1cc7a8f2-f41d-44e8-9b1f-bacc166e50f5. The release also prevents delayed status
events from reopening a closed conversation; a signed out-of-order event regression passed.
HIOBuy integration fixes are released and pushed on its main branch. Its 132 bindings and Portal
AI/product flags are unchanged. No new migration or capability grant was required.

Public repository: https://github.com/hiobuy/supplier-inquiry-demo, main. It starts with a clean source
snapshot; earlier internal development history is retained on the local codex/inquiry-demo branch.
Private state and operational records remain ignored. The release credential-byte scan found no real
secrets in the public snapshot; four Gitleaks findings are reviewed synthetic test literals.

## Recovery rules

Preserve the Worker name/namespace and SQLite data. After changing secrets, deploy and re-bootstrap;
verified credential handles are memory-only and must be revalidated after a restart. Browser bootstrap
performs that automatically. Never replace real API errors with fake replies or create duplicate inquiries
when resuming. Keep private credentials, browser sessions and operational test reports out of Git.
Local Node previews and private history are independent and must not be reset for a deployment.
