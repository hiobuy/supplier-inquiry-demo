// Developer webhook verification: HioBuy-Signature: t=<seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SEC = 300;
const HEADER = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/;

export function signPayload(secret, timestampSec, rawBody) {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.`).update(rawBody).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

/**
 * Verify against candidate secrets [{appId, secret}]. Returns the matching appId or a
 * failure reason. rawBody must be the exact received Buffer.
 */
export function verifySignature(header, rawBody, candidates, nowSec) {
  if (typeof header !== "string") return { ok: false, reason: "SIGNATURE_MISSING" };
  const m = HEADER.exec(header.trim());
  if (!m) return { ok: false, reason: "SIGNATURE_MALFORMED" };
  const t = Number(m[1]);
  if (!Number.isSafeInteger(t) || Math.abs(nowSec - t) > TOLERANCE_SEC) return { ok: false, reason: "SIGNATURE_EXPIRED" };
  const given = Buffer.from(m[2], "hex");
  let match = null;
  for (const c of candidates) {
    const expected = createHmac("sha256", c.secret).update(`${m[1]}.`).update(rawBody).digest();
    // Evaluate every candidate (no early exit) to avoid timing differences between Apps.
    if (expected.length === given.length && timingSafeEqual(expected, given) && !match) match = c.appId;
  }
  return match ? { ok: true, appId: match, timestamp: t } : { ok: false, reason: "SIGNATURE_INVALID" };
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/** Extract allowlisted event fields; tolerate a {data:{...}} wrapper. */
export function parseEvent(parsed) {
  const root = obj(parsed);
  if (!root) return null;
  const eventId = root.event_id ?? root.id;
  const type = root.type ?? root.event_type ?? root.event;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || typeof type !== "string" || !/^[a-z][a-z0-9_.]{1,63}$/.test(type)) return null;
  const inner = obj(root.data) ?? root;
  return {
    eventId,
    type,
    createdAt: typeof root.created_at === "string" ? root.created_at.slice(0, 40) : null,
    appId: typeof (root.app_id ?? inner.app_id) === "string" ? (root.app_id ?? inner.app_id) : null,
    conversation: obj(inner.conversation),
    message: obj(inner.message),
  };
}
