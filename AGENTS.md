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
