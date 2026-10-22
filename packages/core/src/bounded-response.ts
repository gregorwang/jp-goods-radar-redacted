export class ResponseBodyTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(message: string, maximumBytes: number) {
    super(message);
    this.name = "ResponseBodyTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

/**
 * Reads an untrusted response without allowing a missing or dishonest
 * Content-Length header to make the Worker buffer the complete body.
 */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  errorMessage = "response_too_large",
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }

  const declaredHeader = response.headers.get("content-length");
  const declaredBytes = declaredHeader === null ? null : Number(declaredHeader);
  if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    await response.body?.cancel(errorMessage).catch(() => undefined);
    throw new ResponseBodyTooLargeError(errorMessage, maximumBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximumBytes);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximumBytes - offset) {
        await reader.cancel(errorMessage).catch(() => undefined);
        throw new ResponseBodyTooLargeError(errorMessage, maximumBytes);
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(bytes.subarray(0, offset));
}
