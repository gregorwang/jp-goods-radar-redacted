"use client";

import { CircleAlert, RefreshCw } from "lucide-react";

export type LoadState = "loading" | "loaded" | "error";

/**
 * "读取中"与"读取失败"必须与"确实没有数据"区分开。此前多个界面把加载失败
 * 直接渲染成空状态，来源控制台会显示成"零个来源"，运维上会被误读为系统正常。
 * 样式复用 event-manager 已有的 event-loading-state / event-error-state。
 */
export function LoadStateNotice({
  state,
  title,
  loadingTitle,
  loadingHint,
  error,
  onRetry,
}: {
  state: LoadState;
  title: string;
  loadingTitle: string;
  loadingHint?: string;
  error?: string;
  onRetry?: () => void;
}) {
  if (state === "loading") {
    return (
      <div className="event-loading-state" role="status">
        <span aria-hidden="true" />
        <div><strong>{loadingTitle}</strong>{loadingHint ? <p>{loadingHint}</p> : null}</div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="event-error-state" role="alert">
        <CircleAlert aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p>{error || "读取失败"}</p>
          {onRetry ? (
            <button type="button" className="ghost-button" onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />重新读取
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return null;
}
