# image-dedup —— 图片服务（Modal）

> **两个功能都由开关控制，现在都关着**（Modal 额度不够）：建档回执分组 `listing_image_grouping_v1`、精确同款按参考图打分
> `exact_reference_image_v1`（`radar_core.runtime_feature_flags`）。打开步骤见 [docs/成本/成本账本.md](../../docs/成本/成本账本.md) §5。

# 精确同款按参考图打分（`/score`）

用户在精确同款档案上传 1～2 张参考图（管理后台建档页 / 档案详情页，存在 `radar_core.watch_profile_reference_images`），
collector 每轮巡回在日报生成前把漏斗筛剩的候选交过来（`apps/collector/src/exact-reference-image.ts`）。

- Modal 上 `ReferenceScorer`：一台 T4，`@modal.enter()` 里一次装好四个模型，同一台机器里下图 → 指纹 → 对每张参考图做细节比对，
  返回每件对每张参考图的 `{sim, inliers}`；`scaledown_window=2`，算完 2 秒关机。算法和建档回执分组共用 `_embed` / `_match`。
- **门槛在 collector 里**（`IMAGE_MATCH_*`），不在这里：调门槛不用重新部署 Modal。
- 接口：`POST /score` → `{callId}`，`GET /score/<callId>` → 202 running / 200 done。collector 最多等 150 秒。
- 花钱试跑（单次约 $0.005，**跑之前先问用户**）：
  `modal run apps/image-dedup/service.py::score_local --refs a.jpg,b.png --candidates cands.json`

# 建档回执的图片分组

把一封建档回执里的商品按图片合并成"同一款"，结果写进 `radar_core.listing_same_groups`，
完整清单页 `/list/<事件编号>` 有分组就按图片合并，没有就照旧同名折叠。
方法和实测数字：[docs/研究/图片去重-实测-20261008.md](../../docs/研究/图片去重-实测-20261008.md)。

**只有首次建档回执调用。** 每天的日报不调用，照旧同名折叠（用户 2026-10-09 定）。

## 流程

1. collector 回执发出后（`apps/collector/src/listing-grouping.ts`，每两分钟一跳）给存量 ≥30 件的回执建任务，
   把清单页那批商品（链接、图片地址、标题）POST 到 `/start`；骏河屋的图由 collector 下好一起带上——
   Modal 和 VPS 下骏河屋都是 403，只有 Cloudflare 出口能下（2026-10-09 实测，其他平台在 Modal 上全部 200）。
2. Modal 上 `group_receipt`：下图 → 指纹（T4）+ 多件判断（A10G）→ 图片提名 + 标题否决 → 组内细节比对（T4）→ 每件的组号。
3. collector 下一跳 GET `/result/<callId>`，算完了就在一个事务里删旧分组、写新分组、记完成。

失败不影响回执：分组在回执发出后才开始，失败只是清单页继续同名折叠；失败的隔 15 分钟重交，最多 3 次。
任务状态在 `radar_core.listing_group_jobs`（`stats_json` 里有件数、下到几张图、哪个平台没下到、卡片数）。

## 文件

| 文件 | 是什么 |
|---|---|
| `grouping.py` | 判定逻辑，与 `experiments/image-dedup/common.py` 的 `pipeline()` 一致，参数都在这里 |
| `titlerules.py` | 标题否决规则（与实验目录那份相同） |
| `service.py` | Modal 应用：三个模型函数、编排、`/start` `/result` 接口、本地试跑入口 |
| `check_exam.py` | 离线核对：拿实验数据跑 `grouping.run`，和笔记本版逐件比、用考卷打分。不花钱 |

## 改规则 / 参数之前

两份考卷都必须 0 错（初音 `score(labels)`、白羽 `score(labels, shiroha=True)`，在 `experiments/image-dedup/exam.py`）：

```bash
python apps/image-dedup/check_exam.py experiments/image-dedup          # 初音
python apps/image-dedup/check_exam.py experiments/image-dedup/shiroha  # 白羽
```

改了 `titlerules.py` 记得同步实验目录那份（或反过来），并把 `listing-grouping.ts` 的 `METHOD` 升一版。

## 部署和运维

```bash
modal deploy apps/image-dedup/service.py
```

- 口令：Modal Secret `jpgr-image-dedup` 的 `DEDUP_TOKEN` = collector 的 secret `IMAGE_DEDUP_TOKEN`。换口令两边一起换。
- 接口地址在 `apps/collector/wrangler.jsonc` 的 `IMAGE_DEDUP_URL`。
- 重跑一封：`UPDATE radar_core.listing_group_jobs SET status='queued', attempts=0 WHERE event_id='…';`
  （没有行的老回执 `INSERT … VALUES('…','queued')`）。新结果写入前旧分组一直有效。
- 拿一封实验数据在 Modal 上完整试跑（不写库），在档案目录里：
  `modal run ../../apps/image-dedup/service.py::local --out service_result.json`，
  再 `python apps/image-dedup/check_exam.py <档案目录> <档案目录>/service_result.json` 打分。
- 花费：一封千件约 $0.3～0.6；查账 `modal billing report --for today --resolution h`，看 `jpgr-image-dedup`。
