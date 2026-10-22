"use client";

/**
 * 没有这个边界时，任何服务端渲染异常（例如 Collector 一次 503）都会落到 Next
 * 的裸错误页：没有样式、没有重试、也回不到应用里。
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page-wrap">
      <div className="empty-state" role="alert">
        <div>
          <h3>这一页暂时没有加载出来</h3>
          <p>后台服务未在本次请求中返回结果。可以重试，或返回今日情报。</p>
          {error.digest ? <p className="muted-copy">诊断编号 {error.digest}</p> : null}
          <div className="action-row">
            <button type="button" className="primary-button" onClick={reset}>重试</button>
            <a className="ghost-button button-link" href="/dashboard">返回今日情报</a>
          </div>
        </div>
      </div>
    </main>
  );
}
