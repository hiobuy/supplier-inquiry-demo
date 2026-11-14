## Main publication authorized (2026-11-14)

The owner requested merging all accepted HIOAsk work into main and pushing the related repositories.
This includes the deployed Demo recall and image-only support, while preserving the existing main
history. Only historical source-pointer notes conflict; retain the current production implementation.
This Git task does not request deployment, migration, secret changes or new production calls.
Earlier no-push statements below describe previous release checkpoints.

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

# Current production image-only release (2026-11-14)

The owner explicitly approved deploying updates and enabling private Cloudflare R2 images
without an antivirus service for now. MEDIA_ENABLED=images enables PNG/JPEG/WebP only; videos
are refused in the browser and server. Keep visitor/App isolation, existing history and genuine
recall unchanged. Codex owns this work; no paid fallback, new compute resources or Git push.
The upstream HIOAsk raster_validation policy and client image permission must be ready before
this Demo is enabled. Earlier media-disabled instructions below are historical for this release.

# Contributor instructions

- Read docs/HANDOFF.md and relevant source before changing behavior. Keep handoff current.
- This is a fixed-product developer integration demo, not a storefront. No simulated runtime replies.
- Use only the developer's HIOBuy Key through HIOBuy Gateway. Never add HIOAsk integration credentials.
- Keep API Keys and signing secrets server-side. Never commit .dev.vars, .local, SQL, cookies or operational logs.
- Preserve existing history and local preview services. Do not reset data to simplify a test.
- Distinguish fixture tests from real API requests and complete production end-to-end acceptance.
- Production media is disabled. Re-enabling it requires a working upstream processing environment.
- Verify relevant Node/Worker tests after behavior changes. Review App/visitor isolation and webhook signatures.
- Domain binding, production deployment and Git publication require explicit maintainer authorization.
- Use English for code, identifiers, commits and technical documentation.
