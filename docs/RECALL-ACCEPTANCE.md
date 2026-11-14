# Inquiry Demo recall: local implementation and acceptance

Date:2026-11-14. Branch:codex/message-recall; base1f336a4. No push or production change.
Codex implementation/acceptance; bounded Claude Opus5.5 read-only review under existing Pro quota.

## Behavior

Signed ask.message.recalled events require explicit App identity, matching conversation/message,
staff sender, canonical recalled_at and an empty body without media/card. Existing HMAC, App/visitor
ownership, durable event dedup and conflict responses remain. Recall before creation persists a
normal message-cache row; once recalled it cannot be overwritten by stale API/creation events,
even after Node or existing Worker SQL reconstruction. API tombstones are sanitized to empty text
and no card/media; no fake translation or reply is generated. Prior attachment allowlist entries
are removed, preventing content reads even if an upstream still serves the file.

Browser merges are also terminal, suppress original body/card/media, remove a recalled unread reply
and never chime for a recall-only arrival. Current conversation-view generation rejects an API
response from an earlier A-to-B-to-A visit. Normal reply chimes, drafts, polling, historical loading,
closure and rating behavior are retained. Existing DO/SQLite architecture and namespace unchanged.

## Validation

- `npm test`:41 Node tests passed (35 baseline +6 recall/media/client cases).
- `npm run test:worker`:9 actual Worker SQL/runtime tests passed (8 baseline +recall/reconstruction).
-11 independent Chrome checks: signed creation/recall; normal reply display; a real API response
  captured before recall and delivered afterwards; late creation; durable refresh; desktop/mobile
  rendering and no horizontal overflow/runtime errors. Private screenshots/report remain in ignored
  `.local/acceptance/` (demo-recall-desktop.png, demo-recall-mobile.png, browser-report.json).
- Separate HIOAsk/Gateway workerd graph verifies actual cross-service signing, delayed original event,
  original-job retry dedup, Demo HTTP acceptance/SQLite restart, polling, close/rating and suspension.
- Existing Node/Worker suites retain signature expiry, App/visitor isolation, no-credential leakage,
  media policy and ordinary failure/retry coverage. All new evidence uses synthetic local fixtures.

## Boundaries and release advice

No real supplier, production Key, paid translator, live webhook or production history was used.
Production media remains disabled. Malformed upstream recall timestamps are rejected instead of
inventing a valid recall; valid HIOAsk protocol output is required. A recall cannot erase previous
external copies or media already loaded/read/downloaded before revocation.

Release this receiver before HIOAsk opt-in and explicitly add ask.message.recalled to the selected
HIOBuy endpoint. Do not auto-subscribe other endpoints or treat webhook_configured as recall readiness.
Retain tombstone-aware code during rollback. Wait for owner approval for deployment, subscriptions,
real translation/signed callback acceptance and any production migration or Git publication.
