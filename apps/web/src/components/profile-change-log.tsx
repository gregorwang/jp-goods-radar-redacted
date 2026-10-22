"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { apiFetch } from "@/lib/client-api";

interface ChangeEntry {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
  changedAt: string;
  sources: string[];
}

const COLLAPSED_COUNT = 12;

function tokyoClock(iso: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { day: `${part("month")}月${part("day")}日`, time: `${part("hour")}:${part("minute")}` };
}

function scopeText(sources: string[], sourceCount: number): string {
  if (sources.length === 0) return "整份档案";
  if (sourceCount > 1 && sources.length >= sourceCount) return `全部 ${sourceCount} 个来源`;
  if (sources.length > 3) return `${sources.length} 个来源`;
  return sources.join("、");
}

/**
 * 档案页底部的改动记录：几点、改了哪项、从什么改成什么。只看，不能回滚。
 * refreshKey 变了就重读——页面上任何一块保存之后都会推一下它。
 */
export function ProfileChangeLog({ profileId, sourceCount, refreshKey }: {
  profileId: string;
  sourceCount: number;
  refreshKey: number;
}) {
  const [changes, setChanges] = useState<ChangeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ changes: ChangeEntry[] }>(`/api/watch-profiles/${profileId}/changes`, { signal: controller.signal })
      .then((body) => { setChanges(body.changes); setError(""); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "读取失败");
      });
    return () => controller.abort();
  }, [profileId, refreshKey]);

  const visible = (changes ? (expanded ? changes : changes.slice(0, COLLAPSED_COUNT)) : [])
    .map((change) => ({ change, clock: tokyoClock(change.changedAt) }));

  return (
    <section className="paper-panel change-log-panel" aria-labelledby={`change-log-${profileId}`}>
      <div className="panel-header">
        <div><p className="eyebrow">CHANGE LOG</p><h2 id={`change-log-${profileId}`}>改动记录</h2></div>
        {changes && changes.length > 0 && <span className="status-pill">最近 {changes.length} 次</span>}
      </div>
      <div className="panel-body">
        <p className="change-log-intro">这一页上每次保存改了什么，按东京时间记在这里。只用来查，不能从这里撤回。</p>
        {error && <p className="error-copy" role="alert">改动记录没读出来（{error}），设置本身不受影响，刷新页面再试。</p>}
        {!error && changes === null && <p className="change-log-empty" role="status">正在读取…</p>}
        {changes && changes.length === 0 && (
          <div className="change-log-empty">
            <History size={18} aria-hidden="true" />
            <p>还没有改动记录。从 2026 年 10 月 16 日起，这一页上的每次保存都会记在这里。</p>
          </div>
        )}
        {visible.length > 0 && (
          <ol className="change-log-list">
            {visible.map(({ change, clock }, index) => {
              const showDay = index === 0 || visible[index - 1]!.clock.day !== clock.day;
              return (
                <li key={`${change.changedAt}:${change.field}:${index}`} data-new-day={showDay}>
                  {showDay && <p className="change-log-day">{clock.day}</p>}
                  <div className="change-log-row">
                    <time dateTime={change.changedAt}>{clock.time}</time>
                    <div className="change-log-what">
                      <strong>{change.label}</strong>
                      <p>
                        <span className="change-log-before">{change.before ?? "空"}</span>
                        <span className="change-log-arrow" aria-label="改成">→</span>
                        <span className="change-log-after">{change.after ?? "空"}</span>
                      </p>
                    </div>
                    <small>{scopeText(change.sources, sourceCount)}</small>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {changes && changes.length > COLLAPSED_COUNT && (
          <button className="ghost-button change-log-more" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : `再看更早的 ${changes.length - COLLAPSED_COUNT} 条`}
          </button>
        )}
      </div>
    </section>
  );
}
