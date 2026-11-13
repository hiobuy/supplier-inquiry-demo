import { parseProductInput } from "./product.mjs";

export class DefaultsError extends Error {
  constructor() {
    super(
      "Configure the private HIOBUY_API_KEY, HIOBUY_CHANNEL and HIOBUY_PRODUCT_ID defaults.",
    );
    this.name = "DefaultsError";
  }
}
export class FixedDemoDefaults {
  #key;
  constructor(apiKey, product) {
    if (typeof apiKey !== "string" || !/^[!-~]{16,512}$/.test(apiKey))
      throw new DefaultsError();
    this.#key = apiKey;
    this.product = Object.freeze(
      parseProductInput({
        channel: product.channel,
        value: product.id,
        language: product.language ?? "en",
      }),
    );
    Object.freeze(this);
  }
  getKey() {
    return this.#key;
  }
  toJSON() {
    return { product: this.product };
  }
}
