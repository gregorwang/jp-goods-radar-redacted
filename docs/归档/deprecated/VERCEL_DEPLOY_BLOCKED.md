# Vercel CLI 在本机不可用：诊断与部署方案

生成时间：2026-07-27（Asia/Tokyo）　诊断者：Claude Fable 5

## 结论先说

**Vercel CLI 在这台机器上无法执行任何联网命令**，原因是 Windows 计算机名是中文 `me`。这不是网络问题、不是登录问题、也不是插件问题——安装 `vercel` 插件或重新登录都不会解决。

因此 `apps/mercari-service` 的本次改动**尚未部署到生产**，需要用下面"方案"一节中的任一方式发布。

## 症状

```
$ npx vercel whoami
Vercel CLI 57.0.0 (Node.js 24.13.0)
Error: An unexpected error occurred!
Error: Client network socket disconnected before secure TLS connection was established
```

这个报错有误导性——它看起来像被墙或证书问题，实际不是。

## 根因

加上 `--debug` 后暴露出真实异常：

```
TypeError: Cannot convert argument to a ByteString because the character
at index 0 has a value of 27754 which is greater than 255.
    at async Client._fetch (.../vercel/dist/chunks/chunk-4PGF367U.js:1819:5)
    at async fetchUser (...)
```

- 字符码 `27754` = `U+6C6A` = **`汪`**
- 该值来自 `os.hostname()`：

```
$ node -e "const os=require('os');console.log(os.hostname(), os.userInfo().username)"
me me
```

- Vercel CLI 把主机名放进某个 HTTP 请求头。HTTP 头只能承载 latin1（0–255）字节，CJK 字符无法转换成 ByteString，于是**每次请求在构造阶段就抛异常**；CLI 内部重试若干次后，把最终失败报成了那句 TLS 错误。

### 已排除的可能性

| 假设 | 验证 | 结果 |
| --- | --- | --- |
| 网络到 Vercel 不通 | `curl https://api.vercel.com/v2/user` | 403（可达，未认证时的正常响应） |
| Node 的 TLS 栈有问题 | `node -e "fetch('https://api.vercel.com/')"` 等三个域名 | 全部 200 |
| 沙箱限制 | 关闭沙箱重试 | 同样失败 |
| 环境变量可覆盖用户名 | `USERNAME=jpgr USER=jpgr npx vercel whoami` | 同样失败 |
| 环境变量可覆盖主机名 | `COMPUTERNAME=jpgr node -e "os.hostname()"` | 仍返回 `me`（读的是 OS API，不读环境变量） |

**没有环境变量层面的绕过办法。** 同理，`vercel` 插件提供的 `/vercel:deploy`、`/vercel:status` 等命令全部依赖同一个 CLI，在主机名改掉之前都用不了。

## 方案

### 方案 A（推荐）：接 Vercel 的 Git 集成，彻底不用 CLI

一次配置，之后每次 `git push origin main` 自动部署，和 Web 走 Cloudflare Workers Builds 的模式一致。

在 Vercel 控制台对 `jp-goods-radar-mercari` 项目设置：

| 设置项 | 值 |
| --- | --- |
| Git Repository | `gregorwang/jp-goods-radar` |
| Production Branch | `main` |
| Root Directory | `apps/mercari-service` |
| Include source files outside of the Root Directory | **开启**（monorepo 需要仓库根的 `pnpm-lock.yaml` 与 `packages/*`） |
| Install Command | 留空使用默认，或 `pnpm install --frozen-lockfile` |
| Framework Preset | Other |

`apps/mercari-service/vercel.json` 已经声明了 `regions: ["hnd1"]` 与 `functions.maxDuration: 30`，不需要在控制台重复设置。

配好后在 Deployments 页面点一次 Redeploy 让当前 `main` 生效。

### 方案 B：改计算机名为 ASCII

设置 → 系统 → 关于 → 重命名这台电脑 → 改成例如 `jpgr-dev` → 重启。

这会一并修好其他同样把主机名写进 HTTP 头的工具。代价是需要重启，且某些按主机名授权的软件可能要重新激活。改完后 `npx vercel login` 与 `npx vercel --prod` 就能正常用。

### 方案 C：用 REST API + Token 手工部署（不推荐）

技术上可行（Node 的 `fetch` 到 `api.vercel.com` 是通的，绕开 CLI 即可），但需要为每个文件算 SHA-1、逐个上传、再创建 deployment，步骤繁琐易错。只有在 A 和 B 都不可行时才考虑。

## 本次待部署的改动

`apps/mercari-service` 在 commit `34ec523`（批③安全加固）中有四处改动：

1. `src/auth.ts` — 新增重放防护：时间窗内同一签名只接受一次，失败码 `request_replayed`。
2. `api/*.ts`（7 个 handler）— **先验签再做 zod 校验**，未认证调用不再能通过 400 的 issue 列表探明私有 schema，也不再消耗付费调用。
3. 同上 7 个 handler — 验签对象从 `parsed.data` 改为 `request.body`，使签名绑定实际传输的字节。此前 zod 的 `.trim()` 会让带首尾空格的合法查询验签失败。
4. `api/health.ts` — 公开健康端点去掉 `sources` 与 `capabilities`，不再对外暴露抓取目标清单。

### 与 Collector 没有版本耦合

Collector 的签名逻辑本次未改动（仍是签 `payload`、发送 `canonicalJson(payload)`）。新旧两版 mercari-service 都能验签通过，**所以晚部署不会破坏现有采集链路**，可以从容处理。

## 验证是否部署成功

```powershell
curl.exe -sS https://your-mercari-service.vercel.app/api/health
```

- **未部署**（当前状态）：响应里含 `"sources":[...]` 与 `"capabilities":{...}`
- **已部署**：只有 `{"ok":true,"service":"jp-goods-radar-source-adapter","configured":true,"meta":{...}}`

部署后再确认采集链路正常：在管理站来源页对 Mercari 或骏河屋点一次"真实连接测试"，应当返回成功并读到商品；若返回 `request_replayed` 或 `request_signature_invalid`，立即回滚该 Vercel 部署并反馈。
