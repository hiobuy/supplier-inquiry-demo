// Local operator file loader; production reads Cloudflare secrets directly.
import { lstatSync, readFileSync } from "node:fs";
import { DefaultsError, FixedDemoDefaults } from "./fixed-defaults.mjs";
export { DefaultsError, FixedDemoDefaults } from "./fixed-defaults.mjs";

export function loadFixedDemoDefaults(file) {
  try {
    const st = lstatSync(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.size > 8192 ||
      (st.mode & 0o077) !== 0
    )
      throw new DefaultsError();
    const values = {};
    for (const line of readFileSync(file, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)) {
      const m =
        /^\s*(HIOBUY_API_KEY|HIOBUY_CHANNEL|HIOBUY_PRODUCT_ID|HIOBUY_PRODUCT_LANGUAGE)\s*=\s*(.*?)\s*$/.exec(
          line,
        );
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (Object.hasOwn(values, m[1])) throw new DefaultsError();
      values[m[1]] = value;
    }
    return new FixedDemoDefaults(values.HIOBUY_API_KEY, {
      channel: values.HIOBUY_CHANNEL,
      id: values.HIOBUY_PRODUCT_ID,
      language: values.HIOBUY_PRODUCT_LANGUAGE || "en",
    });
  } catch {
    throw new DefaultsError();
  }
}
