import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Structural types for the Vercel Node request/response extensions used here.
 * Keeping them local avoids shipping Vercel's complete build toolchain merely
 * to type-check handlers; Vercel supplies the actual objects at runtime.
 */
export type VercelRequest = IncomingMessage & {
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  body: unknown;
};

export type VercelResponse = ServerResponse & {
  send(body: unknown): VercelResponse;
  json(body: unknown): VercelResponse;
  status(statusCode: number): VercelResponse;
  redirect(statusOrUrl: string | number, url?: string): VercelResponse;
};
