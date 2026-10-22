import { AdapterError } from "../http.js";

export class SurugayaParserError extends AdapterError {
  constructor(message: string, code = "surugaya_parser_error") {
    super(message, code, undefined, false);
    this.name = "SurugayaParserError";
  }
}

export class SurugayaBlockedError extends AdapterError {
  constructor(status: 403 | 429, retryAfterSeconds?: number) {
    super(
      status === 403 ? "骏河屋已阻止当前请求" : "骏河屋请求频率受限",
      status === 403 ? "surugaya_blocked" : "surugaya_rate_limited",
      status,
      status === 429,
      retryAfterSeconds ?? (status === 403 ? 12 * 60 * 60 : 2 * 60 * 60),
    );
    this.name = "SurugayaBlockedError";
  }
}
