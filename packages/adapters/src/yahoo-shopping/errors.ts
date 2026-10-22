import { AdapterError } from "../http.js";

export const YAHOO_EXPERIMENTAL_ERROR_CODES = [
  "yahoo_experiment_disabled",
  "yahoo_invalid_request",
  "yahoo_next_data_missing",
  "yahoo_schema_changed",
  "yahoo_unexpected_redirect",
  "yahoo_captcha",
  "yahoo_login_required",
  "yahoo_page_forbidden",
  "yahoo_rate_limited",
  "yahoo_upstream_error",
  "yahoo_response_too_large",
  "yahoo_timeout",
  "yahoo_network_error",
] as const;

export type YahooExperimentalErrorCode = (typeof YAHOO_EXPERIMENTAL_ERROR_CODES)[number];

export class YahooExperimentalError extends AdapterError {
  constructor(
    message: string,
    code: YahooExperimentalErrorCode,
    status?: number,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(message, code, status, retryable, retryAfterSeconds);
    this.name = "YahooExperimentalError";
  }
}
