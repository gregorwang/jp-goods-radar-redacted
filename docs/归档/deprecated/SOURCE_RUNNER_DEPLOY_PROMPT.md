# 新加坡 VPS source-runner 部署提示词

把下面整段交给负责 VPS 的 AI（它需要该机器的 SSH root 权限）。

---

## 任务

把 `jp-goods-radar` 仓库 `main` 分支最新代码部署到本机的 `jpgr-source-runner` 服务。本次只有两处代码改动，都在 `apps/source-runner/src/`，没有新增依赖、没有新增环境变量、没有数据库变更。

## 环境事实（不要凭猜测改动这些）

- 服务单元：`jpgr-source-runner.service`，运行用户 `jpgr-runner`
- 代码目录：`/opt/jpgr-source-runner/current`（仓库根），工作目录 `/opt/jpgr-source-runner/current/apps/source-runner`
- 启动命令：`/opt/jpgr-source-runner/current/apps/source-runner/node_modules/.bin/tsx src/index.ts`
- 监听 `127.0.0.1:8788`，由 Caddy 以 `/source-runner/*` 前缀反向代理对外
- Playwright 浏览器在 `/opt/jpgr-playwright`（`PLAYWRIGHT_BROWSERS_PATH`）
- 状态目录 `/var/lib/jpgr-source-runner`，systemd 已用 `ProtectSystem=strict` 加固
- 包管理器 pnpm，仓库是 workspace（`apps/*` + `packages/*`），`apps/source-runner` 依赖 `@jpgr/adapters`、`@jpgr/core`、`@jpgr/validation` 三个 workspace 包

## 本次代码改动内容

1. **`src/adaptive-fetch.ts`** — 直连上游 fetch 从自动跟随重定向改为 `redirect: "manual"`，逐跳用 `requireAllowedSourceRunnerUrl` 复验目标是否在该来源的白名单内，重定向深度上限 3。原先允许的主机若 302 到白名单外的地址，响应体会被当作"上游证据"回传给 Cloudflare；现在这条路径被关闭。`fetch` 的公开签名不变，逻辑移入新的私有方法 `#fetchAllowed(request, redirectDepth)`。

2. **`src/server.ts`** — 公开的 `GET /healthz` 只返回 `{ ok: true, data: { service, version }, meta }`，删掉了原先暴露的 `sources`（抓取目标清单）与 `queue`（队列水位）。同时删掉了因此不再使用的 `SOURCE_RUNNER_IDS` import。

注意：`packages/adapters` 也有改动（HTML 实体越界、body 读取超时分类、骏河屋 URL 尾斜杠、Mercari 无出价拍卖价格），source-runner 通过 workspace 依赖使用它们，所以**必须重新 `pnpm install`**，不能只拉代码。

## 部署步骤

```bash
# 1. 记录当前版本，便于回滚
cd /opt/jpgr-source-runner/current
git rev-parse HEAD | tee /root/jpgr-source-runner-rollback-sha.txt

# 2. 拉取最新代码（只做快进，不要 rebase/merge 出新提交）
git fetch origin main
git status --porcelain   # 必须为空；若有本地改动先停下来报告，不要覆盖
git merge --ff-only origin/main

# 3. 安装依赖（workspace 包有改动，必须执行）
pnpm install --frozen-lockfile

# 4. 类型检查（部署前门禁，失败就不要重启服务）
pnpm --filter @jpgr/source-runner typecheck

# 5. 重启服务
systemctl restart jpgr-source-runner
systemctl status jpgr-source-runner --no-pager
```

## 验收（全部要通过）

```bash
# a. 健康端点必须只返回存活性，不再包含 sources / queue
curl -sS http://127.0.0.1:8788/healthz
# 期望形如：{"ok":true,"data":{"service":"jpgr-source-runner","version":1},"meta":{...}}
# 若返回里出现 "sources" 或 "queue"，说明代码没生效，停下来检查

# b. 经 Caddy 的公开路径同样如此
curl -sS https://jp-goods-radar.96-9-210-39.sslip.io:8443/source-runner/healthz

# c. 未签名的任务请求必须被拒（认证仍然生效）
curl -sS -X POST http://127.0.0.1:8788/v1/jobs -H 'content-type: application/json' -d '{}'
# 期望 401，错误码为 request_timestamp_invalid 之类，绝不能是 200

# d. 观察 5 分钟日志，确认没有新的重定向相关错误
journalctl -u jpgr-source-runner -n 100 --no-pager | grep -iE "source_runner_redirect_rejected|source_runner_url_rejected|error" | tail -20
```

关于 (d)：`source_runner_redirect_rejected` 与 `source_runner_url_rejected` 是本次新增的正常防护拒绝路径。**偶发**出现说明防护在工作；但如果某个来源**每次**都因此失败，说明该来源现在依赖一次跨主机重定向，需要把新目标主机加入 `src/source-policy.ts` 的白名单——这种情况请报告，不要自己放宽白名单。

## 回滚

```bash
cd /opt/jpgr-source-runner/current
git checkout "$(cat /root/jpgr-source-runner-rollback-sha.txt)"
pnpm install --frozen-lockfile
systemctl restart jpgr-source-runner
```

## 禁止事项

- 不要改 `jpgr-source-runner.service`、Caddyfile、任何环境变量或端口
- 不要改 `src/source-policy.ts` 的来源白名单
- 不要动 `/var/lib/jpgr-source-runner/business-repair` 里的事故档案
- 不要在这台机器上放任何 Cloudflare / Vercel / Resend 密钥；本服务只需要公开验签公钥，它已在代码里
- 不要执行 `git push`；这台机器只消费代码
