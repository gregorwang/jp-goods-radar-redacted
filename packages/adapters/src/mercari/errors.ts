import { AdapterError } from "../http.js";

export class MercariDpopError extends AdapterError {
  constructor(message = "Mercari DPoP 签名失败") {
    super(message, "mercari_dpop_error", 400, false);
    this.name = "MercariDpopError";
  }
}

export class MercariRateLimitError extends AdapterError {
  constructor(retryAfterSeconds = 2 * 60 * 60) {
    super("Mercari 请求频率受限", "mercari_rate_limited", 429, true, retryAfterSeconds);
    this.name = "MercariRateLimitError";
  }
}

export class MercariBlockedError extends AdapterError {
  constructor() {
    super("Mercari 已阻止当前请求，来源冷却 12 小时", "mercari_blocked", 403, false, 12 * 60 * 60);
    this.name = "MercariBlockedError";
  }
}

/**
 * 商品已被卖家删除或不可见。Mercari 对这种情况返回 403 InvisibleItemException
 * （meta.sub_error_code=410），必须与反爬封禁区分开：前者是这一条商品终结，
 * 后者才是整个来源需要退避。410 会让上层的"跟踪目标已消失"判定直接接管。
 */
export class MercariItemGoneError extends AdapterError {
  constructor(message = "Mercari 商品已被删除或不可见") {
    super(message, "mercari_item_gone", 410, false);
    this.name = "MercariItemGoneError";
  }
}

/** 请求参数被 Mercari 拒绝（InvalidArgument），与 DPoP 签名无关，重试无意义。*/
export class MercariInvalidRequestError extends AdapterError {
  constructor(message = "Mercari 拒绝了请求参数") {
    super(message, "mercari_invalid_request", 400, false);
    this.name = "MercariInvalidRequestError";
  }
}

export class MercariSchemaChangedError extends AdapterError {
  constructor(message = "Mercari 内部 API schema 已变化") {
    super(message, "mercari_schema_changed", undefined, false);
    this.name = "MercariSchemaChangedError";
  }
}
