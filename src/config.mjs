// Server-only configuration. Never contains API keys or secrets. The optional
// webhookConfigFile points to an admin-provisioned private file holding only the HIOBuy
// developer-webhook verification secrets (see loadWebhookSecrets).
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULTS = Object.freeze({ gatewayOrigin: "https://api.hiobuy.com", dataDir: ".local/state", port: 18800, webhookConfigFile: null });

export class ConfigError extends Error {
  constructor(field) { super(`Invalid Inquiry Demo config field: ${field}`); this.name = "ConfigError"; }
}

function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError("gatewayOrigin"); }
  if (url.origin !== value) throw new ConfigError("gatewayOrigin");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ConfigError("gatewayOrigin");
  return value;
}

/** Validate a raw config object; unknown fields (e.g. apiKey) are rejected. */
export function validateConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("root");
  for (const k of Object.keys(raw)) if (!(k in DEFAULTS)) throw new ConfigError(k);
  const merged = { ...DEFAULTS, ...raw };
  const gatewayOrigin = validateOrigin(merged.gatewayOrigin);
  if (typeof merged.dataDir !== "string" || !merged.dataDir || merged.dataDir.includes("\0")) throw new ConfigError("dataDir");
  const dataDir = path.resolve(ROOT_DIR, merged.dataDir);
  const port = merged.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("port");
  const wf = merged.webhookConfigFile;
  if (wf !== null && (typeof wf !== "string" || !wf || wf.includes("\0") || !path.isAbsolute(wf))) throw new ConfigError("webhookConfigFile");
  return Object.freeze({ gatewayOrigin, dataDir, port, webhookConfigFile: wf === null ? null : path.normalize(wf) });
}

/** Load from INQUIRY_DEMO_CONFIG (path to JSON) or fall back to defaults. */
export function loadConfig(env = process.env) {
  const file = env.INQUIRY_DEMO_CONFIG;
  if (!file) return validateConfig({});
  let parsed;
  try { parsed = JSON.parse(readFileSync(path.resolve(ROOT_DIR, file), "utf8")); }
  catch { throw new ConfigError("INQUIRY_DEMO_CONFIG"); }
  return validateConfig(parsed);
}

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET = /^[!-~]{32,512}$/;

/**
 * Load HIOBuy developer-webhook verification secrets from an admin-provisioned private
 * file: {"apps":{"<hiobuyAppId>":{"signingSecret":"..."}}}. The file must be a regular
 * file (no symlink) without any group/world permission bits. Strict fields only; errors
 * never include file contents. Returns Map(appId -> secret).
 */
export function loadWebhookSecrets(file) {
  const fail = () => new ConfigError("webhookConfigFile");
  if (typeof file !== "string" || !path.isAbsolute(file)) throw fail();
  let st;
  try { st = lstatSync(file); } catch { throw fail(); }
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > 64 * 1024) throw fail();
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { throw fail(); }
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(parsed) || Object.keys(parsed).length !== 1 || !isObj(parsed.apps)) throw fail();
  const out = new Map();
  for (const [appId, entry] of Object.entries(parsed.apps)) {
    if (!APP_ID.test(appId) || !isObj(entry) || Object.keys(entry).length !== 1 || typeof entry.signingSecret !== "string" || !SECRET.test(entry.signingSecret)) throw fail();
    out.set(appId, entry.signingSecret);
  }
  // A shared secret would make App attribution ambiguous; every App needs its own.
  if (out.size > 100 || new Set(out.values()).size !== out.size) throw fail();
  return out;
}
