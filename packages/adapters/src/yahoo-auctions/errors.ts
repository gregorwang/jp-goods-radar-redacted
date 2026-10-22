import { AdapterError } from "../http.js";

export const YAHOO_AUCTIONS_ERROR_CODES = [
  "yahoo_auctions_experiment_disabled",
  "yahoo_auctions_invalid_request",
  "yahoo_auctions_invalid_item_id",
  "yahoo_auctions_item_not_found",
  "yahoo_auctions_rate_limited",
  "yahoo_auctions_timeout",
  "yahoo_auctions_network_error",
  "yahoo_auctions_bad_response",
  "yahoo_auctions_upstream_unavailable",
] as const;

export type YahooAuctionsErrorCode = (typeof YAHOO_AUCTIONS_ERROR_CODES)[number];

export class YahooAuctionsError extends AdapterError {
  constructor(
    message: string,
    code: YahooAuctionsErrorCode,
    status?: number,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(message, code, status, retryable, retryAfterSeconds);
    this.name = "YahooAuctionsError";
  }
}
