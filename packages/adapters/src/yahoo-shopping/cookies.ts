const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_COOKIE_COUNT = 32;
const MAX_COOKIE_NAME_LENGTH = 128;
const MAX_COOKIE_VALUE_LENGTH = 4_096;

function splitCombinedSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g).map((part) => part.trim()).filter(Boolean);
}

function setCookieHeaders(headers: Headers): string[] {
  const method = Reflect.get(headers, "getSetCookie");
  if (typeof method === "function") {
    const values: unknown = Reflect.apply(method, headers, []);
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === "string");
  }
  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function expired(attributes: readonly string[]): boolean {
  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.split("=");
    const name = rawName?.trim().toLowerCase();
    const value = rawValue.join("=").trim();
    if (name === "max-age" && Number(value) <= 0) return true;
    if (name === "expires") {
      const expiresAt = Date.parse(value);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
    }
  }
  return false;
}

/** Request-scoped anonymous cookie jar for Yahoo's single fixed origin. */
export class YahooAnonymousCookieJar {
  readonly #cookies = new Map<string, string>();

  capture(headers: Headers): void {
    for (const header of setCookieHeaders(headers)) {
      const [pair, ...attributes] = header.split(";");
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name.length > MAX_COOKIE_NAME_LENGTH || value.length > MAX_COOKIE_VALUE_LENGTH
        || !COOKIE_NAME.test(name) || /[\r\n;]/.test(value)) continue;
      if (!value || expired(attributes)) this.#cookies.delete(name);
      else if (this.#cookies.has(name) || this.#cookies.size < MAX_COOKIE_COUNT) this.#cookies.set(name, value);
    }
  }

  headerValue(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}
