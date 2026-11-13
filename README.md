# HIOBuy Supplier Inquiry Demo

A real, fixed-product page with a **Contact Supplier** button and floating support chat.

Live demo: https://inquiry.demo.hiobuy.com

The operator configures a HIOBuy API Key, product ID and channel on the server. Visitors open
one product and chat without entering credentials. This repository contains no storefront,
cart, checkout, simulated replies, or HIOAsk integration credentials.

## Run locally

Node.js 24+ is required. The local host uses Node's built-in SQLite; there are no runtime npm dependencies.

```sh
npm ci
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
# Set your own HIOBuy API Key and product defaults in .dev.vars.
npm start
```

Open http://localhost:18800. The default backend is the real https://api.hiobuy.com Gateway.
A missing credential or unavailable upstream produces an error; there is no mock fallback.
Optional server configuration: copy `config.example.json` to `.local/config.json` and run
`INQUIRY_DEMO_CONFIG=.local/config.json npm start`. Existing local SQLite data stays in `.local/state`.

| Setting | Purpose |
| --- | --- |
| `HIOBUY_API_KEY` | Your own HIOBuy developer API Key, server only |
| `HIOBUY_CHANNEL` | `1688` or `taobao` |
| `HIOBUY_PRODUCT_ID` | Fixed numeric product ID |
| `HIOBUY_PRODUCT_LANGUAGE` | Product language; defaults to `en` |

The App must have supplier inquiry enabled through HIOBuy administration, and its Key needs
`supplier_inquiry:read` and `supplier_inquiry:write`. Product access depends on the App's channel
entitlements. The hosted production Worker additionally pins the expected App and rejects test Keys.

## Deploy to Cloudflare Workers

See [deployment instructions](docs/DEPLOYMENT.md). Use `wrangler.jsonc` for your own deployment.
`wrangler.production.jsonc` is the configuration of the live HIOBuy demonstration, without secrets.

Production uses private Durable Object SQLite for sessions and message metadata. The HIOBuy API Key
and developer Webhook signing secret are Worker secrets. No API Key is persisted in browser storage,
URLs, cookies, SQL or application logs. Per-visitor verified credential handles expire after one hour;
bootstrap can revalidate the configured server credential after expiry or a Worker restart.

## Message flow

```text
Browser -> Demo backend -> HIOBuy Gateway -> HIOAsk support
HIOAsk -> HIOBuy Gateway -> signed developer Webhook -> Demo
                       + message API reconciliation
```

Developers integrate with HIOBuy. HIOBuy controls identity, access and routing to HIOAsk.
The Demo neither configures nor authenticates directly with HIOAsk. Every conversation is marked
`context.source = inquiry_demo` for support staff.

- Original customer text and replies, stable retry IDs, conversation history and refresh recovery.
- Signed Webhook verification, durable event deduplication, and message API fallback.
- End chat and optional one-time 1–5-star rating.
- Responsive product gallery and chat, a compact full-screen mobile conversation, draft-only question
  suggestions, and unread reply indicators. Product links stay on the product page, outside the chat.
- A quiet reply chime with a mute toggle. Browser audio requires an initial visitor interaction;
  restored history, older pages and repeated Webhook/API deliveries do not play a notification.
- Same-origin CSRF protection, secure production cookies, App/visitor isolation, escaped rendering,
  allowlisted product URLs/images, request limits and bounded bodies.
- The live release is **text only**. Image/video upload UI and endpoints are disabled in production
  until the upstream media processing environment is available. Local media contract tests remain.
- Staff replies follow the upstream 30-second recall window; they appear after release.

The hosted Demo has conservative limits: 30 new visitor sessions/hour/IP, 10 contact attempts/hour/IP,
30 send attempts/hour/IP, 100 send attempts/day for the App, and 240 requests/minute/IP. These are
server-side attempt limits, including rejected retries. Do not use this public demo for sensitive data.

## Webhooks

In HIOBuy Developer Center, select your App and add your HTTPS `/hooks/hiobuy` endpoint for:

- `ask.message.created`
- `ask.conversation.updated`
- `ask.conversation.closed`

Save the once-displayed HIOBuy signing secret on your server. It is distinct from the API Key.
The Worker uses `HIOBUY_WEBHOOK_SECRET`. The Node host supports the private JSON format in
`webhook-config.example.json` through `webhookConfigFile` (absolute path, mode 600).
Never put HIOAsk platform or integration credentials in this project.

## Verify

```sh
npm test
npm run test:worker
```

The Node suite covers local protocols, media validation and security with injected test fixtures.
The Worker suite exercises the actual workerd runtime and Durable Object SQLite using a fixture
Gateway. Fixtures are not imported by the deployed application. See [handoff](docs/HANDOFF.md)
for the separate real production acceptance record.

## License

[MIT](LICENSE).
