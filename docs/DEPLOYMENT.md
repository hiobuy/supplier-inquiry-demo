# Cloudflare deployment

1. Install Node 24+, run `npm ci`, and authenticate Wrangler to your Cloudflare account.
2. Edit `wrangler.jsonc`: unique Worker name, PUBLIC_ORIGIN, HIOBUY_APP_ID, channel/product/language.
   PUBLIC_ORIGIN must be the exact HTTPS origin. Configure an owned custom domain in routes.
3. Store your own production HIOBuy Key securely:

```sh
npx wrangler secret put HIOBUY_API_KEY
```

4. In HIOBuy Developer Center, select this same App. Register
   `https://your-domain.example/hooks/hiobuy` for ask.message.created,
   ask.conversation.updated and ask.conversation.closed. Save its one-time signing secret:

```sh
npx wrangler secret put HIOBUY_WEBHOOK_SECRET
npm run deploy
```

After changing secrets, redeploy and verify `/api/bootstrap` reports the receiver configured.
The live release verified that a secret-only update did not immediately refresh an already-running
Durable Object's environment; a subsequent code deployment activated the new configuration.
Always retain the same Worker and Durable Object namespace to preserve conversation history.
The v1-demo-state migration creates private SQLite storage; no D1 setup is required.

The deploy CLI is pinned to the version validated for this release. A newer CLI's Worker control-plane
lookup returned Cloudflare error 10007 on this account; the pinned transport completed deployment.
The test plugin manages its own runtime tooling separately. Do not bypass TLS errors or expose credentials
in command arguments, URL query strings, browser assets or committed config files.

## Optional same-account Service Binding

The generic config uses the public Gateway. Operators in the HIOBuy Cloudflare account can add:

```json
"services": [{ "binding": "HIOBUY_GATEWAY", "service": "hiobuy-api-gateway" }]
```

Keep HIOBUY_GATEWAY_ORIGIN at the documented public origin even when using the binding.
Third-party deployments do not need access to the HIOBuy Cloudflare account.

## Hosted demonstration

The repository's `wrangler.production.jsonc` describes inquiry.demo.hiobuy.com and its fixed App.
`npm run deploy:production` is for authorized maintainers of that deployment only. Credentials are
separate Worker secrets. This configuration does not grant another developer access to that App.

Verify: health 200, fixed real product, Contact Supplier, a clearly labelled test message, staff
claim/reply, signed Webhook reception, refresh recovery, close and rating. Also verify invalid Key,
cross-App/visitor isolation, disabled media and message API fallback. Keep operational evidence private.
For rollback, deploy a previously verified code version while preserving secrets and Durable Object data.
