function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(",")}}`;
  }
  return "null";
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function serviceSignatureMessage(scope: string, timestamp: string, body: unknown): string {
  return `${scope}\n${timestamp}\n${canonicalJson(body)}`;
}
