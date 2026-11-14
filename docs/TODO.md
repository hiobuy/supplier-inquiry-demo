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

# Follow-up

- Enable production image/video messages only after the upstream secure processing service is deployed.
- Review rate limits and data retention before using this demonstration for sustained public traffic.
- Keep endpoint events, schema handling and tests aligned with the HIOBuy Public API.
- Do not add a complete storefront or a mock demonstration mode without a separate requirement.
