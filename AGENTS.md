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
