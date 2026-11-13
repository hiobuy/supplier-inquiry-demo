# Product scope

A minimal real developer integration demonstration: server-configured HIOBuy Key, channel and product;
real product details; Contact Supplier; product-specific conversations; original text and support replies;
history/refresh recovery; signed HIOBuy developer Webhooks and message API fallback; closure and rating.
The hosted MVP is text-only. Image/video enablement awaits the upstream production processing service.

The browser does not accept or persist the operator's Key. HIOBuy validates identity and forwards calls
to HIOAsk; developers never connect to the support system directly. Messages are identified as Inquiry Demo.
No shopping cart, order, payment or fulfillment implementation. No simulated presentation mode.
