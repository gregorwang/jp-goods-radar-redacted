// 乐天开放 API 的应用配额名义上是每秒一次，但 09-05 生产实测这个间隔并不够：
// 一次锚定轮里 pacer 排出的 1.06s 间隔仍然吃到 429（同一天里 0.27s 的间隔却是 200），
// 说明共享出口 IP 下还叠了配额之外的维度。往上抬一点降低概率；真撞上时由适配器侧的
// withRakutenRateLimit 按 retry-after 重试。
const DEFAULT_INTERVAL_MS = 1_300;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Serializes calls made through one Worker invocation and leaves a small gap
 * between upstream starts. Provider Retry-After handling remains authoritative.
 */
export function createPacedFetch(fetcher: typeof fetch, intervalMs = DEFAULT_INTERVAL_MS): typeof fetch {
  let queue: Promise<void> = Promise.resolve();
  let lastStartedAt = 0;

  const paced = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (init?.signal?.aborted) throw init.signal.reason;
      const waitMs = Math.max(0, lastStartedAt + intervalMs - Date.now());
      if (waitMs > 0) await delay(waitMs);
      if (init?.signal?.aborted) throw init.signal.reason;
      lastStartedAt = Date.now();
      return await fetcher(input, init);
    } finally {
      release();
    }
  };

  return paced as typeof fetch;
}

