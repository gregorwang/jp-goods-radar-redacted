import { describe, expect, it, vi } from "vitest";
import {
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from "../packages/core/src/bounded-response";

describe("bounded upstream responses", () => {
  it("decodes multi-byte text split across chunks", async () => {
    const encoded = new TextEncoder().encode("你好");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 2));
        controller.enqueue(encoded.subarray(2));
        controller.close();
      },
    }));

    await expect(readBoundedResponseText(response, encoded.byteLength)).resolves.toBe("你好");
  });

  it("rejects and cancels a declared oversized response before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }), { headers: { "Content-Length": "5" } });

    await expect(readBoundedResponseText(response, 4, "declared_too_large"))
      .rejects.toEqual(expect.objectContaining({
        name: "ResponseBodyTooLargeError",
        message: "declared_too_large",
        maximumBytes: 4,
      }));
    expect(cancel).toHaveBeenCalledWith("declared_too_large");
  });

  it("rejects and cancels a chunked response that crosses the byte limit", async () => {
    const cancel = vi.fn();
    let pullCount = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? [1, 2, 3] : [4, 5]));
      },
    }));

    await expect(readBoundedResponseText(response, 4, "chunked_too_large"))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(cancel).toHaveBeenCalledWith("chunked_too_large");
    expect(pullCount).toBe(2);
  });
});
