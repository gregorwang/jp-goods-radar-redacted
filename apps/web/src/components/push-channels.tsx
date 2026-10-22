"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoDateTime } from "@/lib/format-time";
import { ConfirmDialog } from "@/components/confirm-dialog";
import styles from "./push-channels.module.css";

interface Group {
  id: string;
  name: string;
  webhookTail: string;
  signed: boolean;
  enabled: boolean;
  /** null = 全部 IP，以后新加的也收。 */
  profileIds: string[] | null;
  createdAt: string;
  last: { at: string; ok: boolean; error: string | null } | null;
}

interface Profile {
  id: string;
  name: string;
  /** keyword / exact_product / item。 */
  kind: string;
  /** 档案本身开没开。 */
  enabled: boolean;
  /** 档案开没开飞书（档案页「通知发到哪」）。没开的在群勾选里是灰的。 */
  feishu: boolean;
}

interface Data {
  feishu: {
    configured: boolean;
    ownerBound: boolean;
    enabled: boolean;
    quotaUsed: number;
    groupImages: boolean;
    groups: Group[];
  };
  profiles: Profile[];
}

/** 和飞书卡片上的短名一致（apps/push-relay/src/feishu/card.ts 的 shortProfileName）；精确同款的日文全名太长，截一下。 */
function shortName(name: string): string {
  const afterBar = name.split(/[｜|]/u).pop() ?? name;
  const short = afterBar.replace(/^同款 · /u, "").replace(/上新$/u, "").trim() || name;
  const chars = [...short];
  return chars.length > 18 ? `${chars.slice(0, 17).join("")}…` : short;
}

const KIND_LABELS: Array<{ kind: string; label: string }> = [
  { kind: "keyword", label: "关键词" },
  { kind: "exact_product", label: "精确同款" },
  { kind: "item", label: "降价（单品）" },
];

/** 点一个档案：从「全部」点掉一个 = 其余全勾；勾满了也还是明确的名单（以后新加的不自动收）。 */
function toggledProfiles(current: string[] | null, id: string, all: Profile[]): string[] {
  const base = current ?? all.map((profile) => profile.id);
  return base.includes(id) ? base.filter((entry) => entry !== id) : [...base, id];
}

/**
 * 群收哪些档案。按「关键词 / 精确同款 / 降价」分开排；没开飞书的档案是灰的、点不了——发不发飞书归档案自己管，
 * 这里勾着的选择照样保留，档案打开飞书后就接着往这个群发。
 */
function ProfileChips({ value, profiles, disabled, onChange }: {
  value: string[] | null;
  profiles: Profile[];
  disabled?: boolean;
  onChange: (next: string[] | null) => void;
}) {
  return (
    <div className={styles.chipGroups} role="group" aria-label="这个群收哪些档案">
      <div className={styles.chips}>
        <button type="button" aria-pressed={value === null} disabled={disabled} onClick={() => onChange(null)}>
          全部<small>以后新加的也收</small>
        </button>
      </div>
      {KIND_LABELS.map(({ kind, label }) => {
        const mine = profiles.filter((profile) => profile.kind === kind);
        if (mine.length === 0) return null;
        return (
          <div key={kind} className={styles.chipGroup}>
            <p className={styles.label}>{label}</p>
            <div className={styles.chips}>
              {mine.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  title={profile.feishu ? profile.name : `${profile.name}（没开飞书：去档案页「通知发到哪」打开）`}
                  aria-pressed={value === null || value.includes(profile.id)}
                  data-implicit={value === null}
                  data-off={!profile.feishu}
                  disabled={disabled || !profile.feishu}
                  onClick={() => onChange(toggledProfiles(value, profile.id, profiles))}
                >
                  {shortName(profile.name)}
                  {!profile.feishu ? <small>没开飞书</small> : !profile.enabled ? <small>档案暂停中</small> : null}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function scopeText(group: Group, profiles: Profile[]): string {
  if (group.profileIds === null) return "全部档案（开了飞书的）";
  if (group.profileIds.length === 0) return "一个档案都没勾，什么都不会收到";
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return group.profileIds.map((id) => {
    const profile = byId.get(id);
    if (!profile) return "已删除的档案";
    return profile.feishu ? shortName(profile.name) : `${shortName(profile.name)}（没开飞书）`;
  }).join("、");
}

function GroupRow({ group, profiles, onSaved, onDelete }: {
  group: Group;
  profiles: Profile[];
  onSaved: (group: Group) => void;
  onDelete: (group: Group) => void;
}) {
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");

  async function patch(body: Record<string, unknown>, done?: string) {
    setBusy("save");
    setNote(null);
    try {
      const result = await apiFetch<{ group: Group }>(`/api/push-channels/groups/${group.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onSaved(result.group);
      if (done) setNote({ ok: true, text: done });
      return true;
    } catch (reason) {
      setNote({ ok: false, text: `没保存上：${apiErrorMessage(reason, "推送服务没响应")}` });
      return false;
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setNote(null);
    try {
      const result = await apiFetch<{ cards: number }>(`/api/push-channels/groups/${group.id}/test`, { method: "POST" });
      setNote({ ok: true, text: `发过去了（${result.cards} 张），去群里看一眼。` });
    } catch (reason) {
      setNote({ ok: false, text: apiErrorMessage(reason, "试发失败") });
    } finally {
      setBusy("");
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    if (name.trim() !== group.name) body.name = name;
    if (webhookUrl.trim()) {
      body.webhookUrl = webhookUrl;
      body.secret = secret;
    }
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    if (await patch(body, body.webhookUrl ? "地址换好了，点「试发」确认一下。" : "改好了。")) {
      setEditing(false);
      setWebhookUrl("");
      setSecret("");
    }
  }

  const failing = group.last !== null && !group.last.ok;
  return (
    <li className={styles.group} data-enabled={group.enabled}>
      <div className={styles.groupHead}>
        <div className={styles.groupTitle}>
          <div className={styles.nameLine}>
            <strong>{group.name}</strong>
            <button type="button" className={styles.rename} aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
              <Pencil size={12} aria-hidden="true" />{editing ? "收起" : "改名"}
            </button>
          </div>
          <span>{group.enabled ? "开着" : "已暂停"} · 地址 {group.webhookTail}{group.signed ? " · 已签名" : ""}</span>
        </div>
        <button
          type="button"
          className={styles.switch}
          aria-pressed={group.enabled}
          disabled={busy !== ""}
          onClick={() => void patch({ enabled: !group.enabled }, group.enabled ? "这个群暂停了，别的群和私聊照发。" : "这个群恢复了。")}
        >
          {group.enabled ? "暂停这个群" : "恢复这个群"}
        </button>
      </div>

      <div className={styles.groupBody}>
        <p className={styles.label}>收哪些档案 <em>{scopeText(group, profiles)}</em></p>
        <ProfileChips
          value={group.profileIds}
          profiles={profiles}
          disabled={busy !== ""}
          onChange={(next) => void patch({ profileIds: next })}
        />
        <p className={failing ? styles.lastFailed : styles.last}>
          {group.last === null
            ? "还没往这个群发过。"
            : group.last.ok
              ? `最近一次 ${tokyoDateTime(group.last.at)} 发成功。`
              : `最近一次 ${tokyoDateTime(group.last.at)} 没发出去：${group.last.error ?? "原因不明"}。多半是群机器人被删了或签名换了，在群设置里看一下，再「换地址」。`}
        </p>
        {note && <p className={note.ok ? styles.ok : styles.error} role="status">{note.text}</p>}
      </div>

      <div className={styles.groupActions}>
        <button type="button" className="ghost-button" disabled={busy !== ""} onClick={() => void test()}>
          <Send size={13} aria-hidden="true" />{busy === "test" ? "正在发…" : "试发"}
        </button>
        <button type="button" className="ghost-button" aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
          {editing ? "收起" : "换地址"}
        </button>
        <button type="button" className={`ghost-button ${styles.danger}`} disabled={busy !== ""} onClick={() => onDelete(group)}>
          <Trash2 size={13} aria-hidden="true" />删除
        </button>
      </div>

      {editing && (
        <form className={styles.form} onSubmit={(event) => void saveEdit(event)}>
          <label>
            <span>群名</span>
            <input className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>新的 webhook 地址（不换就留空）</span>
            <input className="text-input" value={webhookUrl} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" onChange={(event) => setWebhookUrl(event.target.value)} />
          </label>
          {webhookUrl.trim() && (
            <label>
              <span>签名密钥（机器人没开签名校验就留空）</span>
              <input className="text-input" value={secret} onChange={(event) => setSecret(event.target.value)} />
            </label>
          )}
          <div><button className="primary-button" type="submit" disabled={busy !== ""}>保存</button></div>
        </form>
      )}
    </li>
  );
}

function AddGroup({ profiles, onAdded }: { profiles: Profile[]; onAdded: (group: Group, note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [profileIds, setProfileIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let created: Group;
    try {
      created = (await apiFetch<{ group: Group }>("/api/push-channels/groups", {
        method: "POST",
        body: JSON.stringify({ name, webhookUrl, secret, profileIds }),
      })).group;
    } catch (reason) {
      setError(`没加上：${apiErrorMessage(reason, "推送服务没响应")}。填的内容还在，改一下再点。`);
      setBusy(false);
      return;
    }
    // 加完马上试发一张：地址或签名填错了，当场就知道。
    let note: string;
    try {
      await apiFetch(`/api/push-channels/groups/${created.id}/test`, { method: "POST" });
      note = `「${created.name}」加好了，已经往群里试发了一张，去看一眼。`;
    } catch (reason) {
      note = `「${created.name}」加上了，但试发失败：${apiErrorMessage(reason, "原因不明")}。检查地址和签名后点「换地址」。`;
    }
    onAdded(created, note);
    setName("");
    setWebhookUrl("");
    setSecret("");
    setProfileIds(null);
    setOpen(false);
    setBusy(false);
  }

  if (!open) {
    return (
      <button type="button" className={styles.add} onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden="true" />再加一个群
      </button>
    );
  }
  return (
    <form className={`${styles.form} ${styles.addForm}`} onSubmit={(event) => void submit(event)}>
      <p className={styles.hint}>
        在飞书群里：群设置 → 群机器人 → 添加机器人 → 自定义机器人。复制它给的 webhook 地址；
        如果勾了「签名校验」，把签名密钥也复制过来。
      </p>
      <label>
        <span>群名（自己认得出就行）</span>
        <input className="text-input" value={name} maxLength={40} required onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>webhook 地址</span>
        <input className="text-input" value={webhookUrl} required placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" onChange={(event) => setWebhookUrl(event.target.value)} />
      </label>
      <label>
        <span>签名密钥（没开签名校验就留空）</span>
        <input className="text-input" value={secret} onChange={(event) => setSecret(event.target.value)} />
      </label>
      <div>
        <p className={styles.label}>收哪些档案</p>
        <ProfileChips value={profileIds} profiles={profiles} disabled={busy} onChange={setProfileIds} />
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formActions}>
        <button className="primary-button" type="submit" disabled={busy || !name.trim() || !webhookUrl.trim()}>{busy ? "正在加…" : "加上并试发"}</button>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      </div>
    </form>
  );
}

/**
 * 侧栏「推送」：飞书私聊开关 + 每个群一行（开关、收哪些 IP、最近一次发成功没有、试发、删除）。
 * 数据都在 push-relay 里（apps/push-relay/src/feishu/desk.ts 的 feishu_groups），这页只是遥控器。
 */
export function PushChannels() {
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Group | null>(null);
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<Data>("/api/push-channels", { signal: controller.signal })
      .then((body) => {
        setData(body);
        setState("loaded");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(apiErrorMessage(reason, "推送设置读取失败"));
        setState("error");
      });
    return () => controller.abort();
  }, [requestKey]);

  const replaceGroup = useCallback((group: Group) => {
    setData((current) => current && {
      ...current,
      feishu: { ...current.feishu, groups: current.feishu.groups.map((entry) => entry.id === group.id ? group : entry) },
    });
  }, []);

  async function toggleOwner() {
    if (!data) return;
    setOwnerBusy(true);
    setMessage("");
    try {
      const result = await apiFetch<{ enabled: boolean }>("/api/push-channels/owner", {
        method: "POST",
        body: JSON.stringify({ enabled: !data.feishu.enabled }),
      });
      setData({ ...data, feishu: { ...data.feishu, enabled: result.enabled } });
      setMessage(result.enabled ? "私聊推送恢复了。" : "私聊推送暂停了，群照发。");
    } catch (reason) {
      setMessage(`没切换成：${apiErrorMessage(reason, "推送服务没响应")}`);
    } finally {
      setOwnerBusy(false);
    }
  }

  async function remove(group: Group) {
    await apiFetch(`/api/push-channels/groups/${group.id}`, { method: "DELETE" });
    setData((current) => current && {
      ...current,
      feishu: { ...current.feishu, groups: current.feishu.groups.filter((entry) => entry.id !== group.id) },
    });
    setMessage(`「${group.name}」删掉了。群里的机器人还在，不想要的话去群设置里移除。`);
    setPendingDelete(null);
  }

  if (state === "loading") return <p className={styles.hint}>正在读取推送设置…</p>;
  if (state === "error" || !data) {
    return (
      <section className="paper-panel">
        <div className={`panel-body ${styles.intro}`}>
          <p className={styles.error} role="alert">{error}</p>
          <div><button type="button" className="ghost-button" onClick={() => { setState("loading"); setRequestKey((key) => key + 1); }}>再试一次</button></div>
        </div>
      </section>
    );
  }

  const { feishu } = data;
  const profiles = data.profiles;
  const feishuOn = profiles.filter((profile) => profile.feishu).length;
  const on = feishu.groups.filter((group) => group.enabled).length;
  return (
    <div className="detail-stack reveal reveal-delay-1">
      <section className="paper-panel">
        <div className="panel-header">
          <div><p className="eyebrow">PUSH CHANNELS</p><h2>推送 · 飞书</h2></div>
        </div>
        <div className={`panel-body ${styles.intro}`}>
          <p>
            <strong>一个档案发不发飞书，在档案页「通知发到哪」里开</strong>（现在 {feishuOn} 个档案开着）；这里管发到哪些群。
            私聊和每个群各管各的：暂停私聊不影响群，暂停一个群不影响别的群。每个群可以只收某几个档案，没新货就不打扰它。
            只开飞书的档案，一个群、私聊都没收到时会自动改发邮件。
          </p>
          <p className={styles.hint}>
            群消息不花飞书额度；图片所有群共用一份，群再多额度也不涨。本月已用 {feishu.quotaUsed.toLocaleString("en-US")} / 10,000 次。
            {feishu.groupImages ? "" : " 群现在是纯标题版（不带图）。"}
          </p>
          {message && <p className={styles.ok} role="status">{message}</p>}
        </div>
      </section>

      <section className="watch-listing-evidence" aria-labelledby="push-owner">
        <header>
          <div>
            <p className="eyebrow">PRIVATE</p>
            <h3 id="push-owner">我的私聊</h3>
            <p>飞书里给机器人发「暂停」「恢复」、点状态卡上的按钮，和这里是同一个开关。</p>
          </div>
        </header>
        <div className={styles.owner}>
          {!feishu.configured || !feishu.ownerBound
            ? <p className={styles.hint}>还没绑定：在飞书里私聊机器人随便发一句，就绑上了。</p>
            : (
              <>
                <p><strong>{feishu.enabled ? "开着" : "已暂停"}</strong>{feishu.enabled ? "，每小时有新货就发给你。" : "，新货不发到私聊（暂停期间的不补发）。"}</p>
                <button type="button" className={styles.switch} aria-pressed={feishu.enabled} disabled={ownerBusy} onClick={() => void toggleOwner()}>
                  {feishu.enabled ? "暂停私聊" : "恢复私聊"}
                </button>
              </>
            )}
        </div>
      </section>

      <section className="watch-listing-evidence" aria-labelledby="push-groups">
        <header>
          <div>
            <p className="eyebrow">GROUPS</p>
            <h3 id="push-groups">群 <small className={styles.count}>{on} / {feishu.groups.length} 个开着</small></h3>
            <p>群里的卡片没有「不想看」「等降价」按钮（飞书群机器人做不到），点标题直接去商品页。</p>
          </div>
        </header>
        {feishu.groups.length === 0
          ? <p className={`${styles.hint} ${styles.empty}`}>还没有群。</p>
          : (
            <ul className={styles.groups}>
              {feishu.groups.map((group) => (
                <GroupRow key={group.id} group={group} profiles={profiles} onSaved={replaceGroup} onDelete={setPendingDelete} />
              ))}
            </ul>
          )}
        <div className={styles.addWrap}>
          <AddGroup
            profiles={profiles}
            onAdded={(group, note) => {
              setData((current) => current && { ...current, feishu: { ...current.feishu, groups: [...current.feishu.groups, group] } });
              setMessage(note);
              setRequestKey((key) => key + 1);
            }}
          />
        </div>
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        eyebrow="REMOVE GROUP"
        title={`删除「${pendingDelete?.name ?? ""}」？`}
        description="删了以后不再往这个群发。想再接回来，要重新粘贴 webhook 地址。只是想停一阵子的话，用「暂停这个群」就行。"
        confirmLabel="删除"
        cancelLabel="先不删"
        busyLabel="正在删除…"
        errorFallback="没删掉，请稍后再试。"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete ? remove(pendingDelete) : Promise.resolve()}
      />
    </div>
  );
}
