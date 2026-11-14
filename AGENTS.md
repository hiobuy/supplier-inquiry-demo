# Current production image source (2026-11-14)

The owner-approved image-only R2 release is implemented in ../inquiry-images-demo,source935d9d6,
active100% version b5c1b0bc-ed60-4fad-9d3a-5250d2d5d74b. Current production supports PNG/JPEG/
WebP through authenticated private R2; video disabled, no antivirus service per owner instruction.
Existing visitors/App/credentials/history preserved.52 local Demo tests and27 real end-to-end
production image checks passed, including signed recall and privacy. Current HIOAsk source and
release evidence: ../v2-images-r2/docs/R2-IMAGES-RELEASE-2026-11-14.md.
This original source/preview is historical; do not deploy it over the verified release. No Git push.

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
