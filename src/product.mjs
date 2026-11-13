// Product input parsing and defensive normalization of the official product detail.
// Never trusts upstream URLs/HTML; the canonical product URL is built from validated IDs.

export const LANGUAGES = Object.freeze({
  "1688": ["en", "ja", "ko", "ru", "vi", "fr", "pt", "zh-tw", "es", "id", "th"],
  taobao: ["en", "ja", "ko", "ru", "vi", "cn"],
});

export class ProductInputError extends Error {
  constructor(message) { super(message); this.name = "ProductInputError"; this.code = "INVALID_PRODUCT_INPUT"; }
}

const NUMERIC_ID = /^[0-9]{5,20}$/;

/**
 * Parse {channel?, value, language?}. Accepts official 1688/Taobao/Tmall item URLs or a
 * numeric ID with explicit channel. Returns {channel, id, slot, url, language}.
 */
export function parseProductInput(body) {
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new ProductInputError("Enter an official product URL or numeric ID.");
  let channel; let id; let host = null;
  if (NUMERIC_ID.test(value)) {
    if (body.channel !== "1688" && body.channel !== "taobao") throw new ProductInputError("Choose a product channel for a numeric ID.");
    channel = body.channel; id = value;
  } else {
    let url;
    try { url = new URL(value); } catch { throw new ProductInputError("Invalid product URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new ProductInputError("Use an official HTTPS product URL.");
    if (url.hostname === "detail.1688.com") {
      const m = /^\/offer\/([0-9]{5,20})\.html$/.exec(url.pathname);
      if (!m) throw new ProductInputError("Unsupported 1688 product URL.");
      channel = "1688"; id = m[1];
    } else if (url.hostname === "item.taobao.com" || url.hostname === "detail.tmall.com") {
      const pid = url.searchParams.get("id");
      if (url.pathname !== "/item.htm" || !pid || !NUMERIC_ID.test(pid)) throw new ProductInputError("Unsupported Taobao/Tmall product URL.");
      channel = "taobao"; id = pid; host = url.hostname;
    } else {
      throw new ProductInputError("Only 1688, Taobao and Tmall item URLs are supported.");
    }
    if (body.channel !== undefined && body.channel !== channel) throw new ProductInputError("URL does not match the selected channel.");
  }
  const language = body.language === undefined ? "en" : body.language;
  if (typeof language !== "string" || !LANGUAGES[channel].includes(language)) throw new ProductInputError("Unsupported language for this channel.");
  const url = channel === "1688" ? `https://detail.1688.com/offer/${id}.html`
    : `https://${host === "detail.tmall.com" ? "detail.tmall.com" : "item.taobao.com"}/item.htm?id=${id}`;
  return { channel, id, slot: `${channel}:${id}`, url, language };
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const cp = (s) => [...s];

function plain(value, max) {
  if (typeof value !== "string") return null;
  // Strip control chars; collapse whitespace. Rendering is textContent-only anyway.
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const chars = cp(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

/** Exact non-alicdn image hosts observed in official product detail (no wildcards). */
export const EXTRA_IMAGE_HOSTS = Object.freeze(["global-img-cdn.1688.com"]);

/** Only official HTTPS Alibaba image CDN hosts; no credentials/ports/IPs. */
export function safeImageUrl(value) {
  if (typeof value !== "string" || value.length > 1024) return null;
  const raw = value.startsWith("//") ? `https:${value}` : value;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.alicdn\.com$/.test(url.hostname) && !EXTRA_IMAGE_HOSTS.includes(url.hostname)) return null;
  if (!/\.(jpe?g|png|webp)(_[A-Za-z0-9.]+)?$/i.test(url.pathname)) return null;
  url.hash = "";
  return url.href;
}

function variantLabel(v) {
  if (typeof v === "string") return plain(v, 80);
  const o = obj(v);
  for (const k of ["name", "title", "label", "spec", "sku_name"]) {
    const t = o[k];
    if (typeof t === "string") return plain(t, 80);
    const tt = obj(t);
    if (typeof tt.translated === "string" && tt.translated) return plain(tt.translated, 80);
    if (typeof tt.original === "string") return plain(tt.original, 80);
  }
  if (Array.isArray(o.props)) {
    const parts = o.props.slice(0, 4).map((p) => {
      const po = obj(p);
      const val = typeof po.value === "string" ? po.value : obj(po.value).translated ?? obj(po.value).original;
      return typeof val === "string" ? val : null;
    }).filter(Boolean);
    if (parts.length) return plain(parts.join(" / "), 80);
  }
  return null;
}

/**
 * Normalize the official product detail payload. Accepts ROOT {product, request_id} or
 * {data:{product,...}}. Returns null if no usable title (never invents details).
 */
export function normalizeProduct(payload, parsed) {
  const root = obj(payload);
  const product = obj(root.product ?? obj(root.data).product);
  const t = obj(product.title);
  const title = plain(typeof t.translated === "string" && t.translated ? t.translated
    : typeof t.original === "string" ? t.original : product.title, 300);
  if (!title) return null;
  const images = [];
  const push = (u) => { const s = safeImageUrl(u); if (s && !images.includes(s) && images.length < 8) images.push(s); };
  push(product.image);
  if (Array.isArray(product.images)) for (const im of product.images.slice(0, 20)) push(typeof im === "string" ? im : obj(im).url);
  const price = obj(product.price);
  let priceLabel = null;
  const amount = price.original_amount;
  const currency = price.original_currency;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount < 1e9
      && typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
    priceLabel = `${currency} ${amount.toFixed(2)}`;
  }
  const variants = Array.isArray(product.variants) ? product.variants : null;
  const variantLabels = variants ? [...new Set(variants.slice(0, 50).map(variantLabel).filter(Boolean))].slice(0, 8) : [];
  return {
    slot: parsed.slot,
    channel: parsed.channel,
    product_id: parsed.id,
    url: parsed.url,
    language: parsed.language,
    title,
    images,
    price_label: priceLabel,
    seller: plain(obj(product.seller).name, 100),
    variant_count: variants ? variants.length : null,
    variant_labels: variantLabels,
    request_id: plain(root.request_id ?? obj(root.data).request_id, 128),
  };
}

/** Title clipped to HIOAsk context/product_card bound (200 code points). */
export function cardTitle(title) {
  const chars = cp(title);
  return chars.length > 200 ? chars.slice(0, 199).join("") + "…" : title;
}
