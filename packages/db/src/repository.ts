/**
 * `RadarRepository`——全系统唯一的数据库访问入口。
 *
 * 这个文件曾经是 3415 行。拆分的唯一目的是让它能被完整读进上下文：过千行之后，
 * 无论是人还是 AI，每次修改都只能看到其中一段，于是重复实现已有逻辑、改了 A 处
 * 不知道 B 处依赖它。文件越大，这个问题恶化得越快。
 *
 * 拆法是**继承链**，不是把方法改写成自由函数。理由是这样方法体可以逐字搬运、
 * `this.db` 与方法间调用全部照旧，因此"没搬错"可以由 `pnpm -r typecheck` 直接证明，
 * 不需要人工逐行核对。代价是链上的顺序有意义：
 *
 *     RepositoryBase        只持有 db
 *       └ OpsRepository     运维与验证（markVerification 被探针和心跳调用）
 *        └ HealthRepository 每日体检（weeklyHealthSummary 被周报调用）
 *         └ QuotaRepository 配额与计数（incrementCounter 被邮件投递调用）
 *           └ QueueRepository
 *             └ TrackedListingRepository
 *               └ BindingRepository
 *                 └ RunRepository          调用 OpsRepository.markVerification
 *                   └ ListingRepository
 *                     └ EventRepository
 *                       └ DigestRepository
 *                         └ DeliveryRepository  通知登记簿（各渠道共用）+ 邮件取件；调用 QuotaRepository.incrementCounter
 *                           └ PushRepository    飞书推送的取件、补邮件、收尾
 *                             └ RadarRepository
 *
 * **加方法时的唯一规矩：** 如果新方法要调用别组的方法，那一组必须排在本组之前。
 * 排错了 typecheck 会直接报错，不会静默出问题。
 *
 * 各组的具体职责见 `src/queries/` 下每个文件顶部的说明。
 */
import { PushRepository } from "./queries/push";

export type { PendingPushRow, ReturnedToEmail } from "./queries/push";

export { keywordBaselineResetStatements } from "./queries/shared";
export { SAME_DAY_RETRY_DELAY_SECONDS, sameDayRetryEligible } from "./queries/bindings";

export class RadarRepository extends PushRepository {}
