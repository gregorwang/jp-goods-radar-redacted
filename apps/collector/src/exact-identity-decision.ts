import type { ProductMatchDifference, ProductMatchRelation } from "@jpgr/core";

/**
 * 精确同款的最终裁决规则。
 *
 * 单独成模块是有意的：它是一个纯函数，只依赖类型，不碰数据库、队列或任何
 * 运行时环境。这样离线工具（比如部署前的定向重判草案）可以直接引它，
 * 而不是再抄一份——判定规则抴两份，早晚会漂成两套。
 */

/**
 * 判定理由码。它解释**为什么**得到这个档位，不是新的隐藏业务档位
 * （计划 §8.3：finalDecision 仍然只有 confirmed / uncertain / rejected）。
 */
export type ExactIdentityReasonCode =
  /** 目标身份要素全部命中且无冲突，文本已经证明身份。 */
  | "deterministic_identity_proven"
  /** 来源可追溯的 JAN / 型号同范围命中（计划 §8.2 路径 A）。 */
  | "identifier_match"
  /** 程序可核查的字段冲突：JAN、型号、排除词、厂商、系列、尺寸、颜色。 */
  | "deterministic_conflict"
  /** 候选文本与目标没有任何身份重叠。程序可证明的「无关」，不是「还没看」。 */
  | "no_identity_anchor"
  /** 模型给出带引用的同款结论。 */
  | "semantic_same_product"
  /** 模型给出带引用的不同商品结论。 */
  | "semantic_different_product"
  /** 身份可能成立，但挂牌卖的是什么（单件 / 套装 / 随机 BOX）尚未判清。 */
  | "sale_unit_unresolved"
  /** 模型明确表示证据不足，或表态缺少原文引用。 */
  | "identity_evidence_missing"
  /** 标题省略了身份信息，需要详情才能判断；详情尚未读取。 */
  | "candidate_detail_required"
  /** 候选带着目标没有的版本 / 活动 / 销售单位标记，它可能是兄弟款。 */
  | "candidate_has_extra_distinguisher"
  /** 模型输出缺失、重复、错位或不符合契约。这是技术失败，不是业务结论。 */
  | "model_output_invalid"
  /** 这一条还没送过模型。 */
  | "model_not_executed";

/**
 * 理由码写给用户看的那一句。
 *
 * AGENTS.md §4：降档时那行差异说明是这条记录的全部价值，写不出具体缺了什么，
 * 等于没降档。所以这里一句机器话都不能有——「同款关系 related，置信度 low」
 * 对用户没有任何意义，「标题没写版本、详情还没读」才有。
 */
export const EXACT_IDENTITY_REASON_TEXT: Record<ExactIdentityReasonCode, string> = {
  deterministic_identity_proven: "商品身份要素全部命中，且无冲突字段",
  identifier_match: "来源标注的 JAN / 型号与目标一致，且无冲突字段",
  deterministic_conflict: "存在可核查的字段冲突",
  no_identity_anchor: "候选文本与目标没有任何身份重叠",
  semantic_same_product: "语义复核引用原文确认同款",
  semantic_different_product: "语义复核引用原文指出这是另一件商品",
  sale_unit_unresolved: "身份可能一致，但这条挂牌实际卖的是单件还是套装尚未判清",
  identity_evidence_missing: "候选文本尚不足以区分具体版本",
  candidate_detail_required: "标题省略了身份信息，详情尚未读取",
  candidate_has_extra_distinguisher: "候选带有目标没有的版本 / 活动 / 整盒标记，需要核实是否同一款",
  model_output_invalid: "本次语义复核输出无效，未形成结论",
  model_not_executed: "这一条尚未进入语义复核",
};

/** 处理状态，与业务档位分开记录（计划 §9.3）。 */
export type ExactIdentityProcessingStatus = "complete" | "pending_action" | "failed";

/** 挂牌实际卖的对象与目标的关系（计划 §8.1）。P1 只区分能可靠区分的三档。 */
export type ExactIdentitySaleRelation = "target_unit" | "contains_target" | "unknown";

export type ExactIdentityAiItemStatus =
  | "ready"
  | "missing"
  | "contract_error"
  | "duplicate"
  | "key_mismatch"
  | "not_executed";

export interface ExactIdentityDecisionInput {
  relation: ProductMatchRelation;
  /** 模型原始表态。未执行或无效时为 undefined。 */
  output?: Record<string, unknown>;
  /** 确定性匹配结果。旧数据可能只带 difference，没有 conflicts。 */
  match?: {
    difference?: ProductMatchDifference;
    conflicts?: readonly string[];
    matchedFields?: readonly string[];
  };
  /** 这一条模型输出的处理状态（来自严格批次校验）。 */
  aiItemStatus?: ExactIdentityAiItemStatus;
}

export interface ExactIdentityDecision {
  decision: "confirmed" | "rejected" | "uncertain";
  decisionSource: "workflow_matcher" | "workflow_ai";
  confidence: "high" | "medium" | "low";
  reasonCode: ExactIdentityReasonCode;
  processingStatus: ExactIdentityProcessingStatus;
  saleRelation: ExactIdentitySaleRelation;
}

/** JAN / 型号 / 排除词冲突是硬反证，其余字段冲突是可核查但较软的反证。 */
function hardConflict(conflicts: readonly string[]): boolean {
  return conflicts.some((value) => value.startsWith("JAN")
    || value.startsWith("型号")
    || value.startsWith("排除词"));
}

function quotedEvidenceCount(output: Record<string, unknown> | undefined): number {
  if (!output || !Array.isArray(output.evidence)) return 0;
  return (output.evidence as unknown[]).filter((entry) => entry !== null
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).quote === "string"
    && ((entry as Record<string, unknown>).quote as string).trim().length > 0).length;
}

function stringListLength(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").length : 0;
}

/**
 * 从模型输出推断销售对象关系。
 *
 * 刻意保守：includedItems 列了三件东西，可能是「本体＋台座＋特典」这样的包装清单，
 * 也可能是三件不同商品的套装。程序分不清，所以这里只把它降级成「尚未判清」，
 * 绝不靠 includedItems.length > 1 直接拒绝——计划 §8.1 明确点名禁止这种写法。
 */
function saleRelationOf(
  relation: ProductMatchRelation,
  output: Record<string, unknown> | undefined,
): ExactIdentitySaleRelation {
  if (relation === "bundle") return "contains_target";
  if (!output) return "unknown";
  return stringListLength(output.includedItems) > 1 ? "unknown" : "target_unit";
}

/**
 * 精确同款的最终裁决。
 *
 * 这一版拆掉了四条计划 §8.5 点名的短路：
 *
 * 1. exact 不再「不经证据分类一律 confirmed」——有冲突就不是同款，哪怕分数够高。
 * 2. related 且模型没表态不再一律 rejected。模型不肯背书不是反证，是还没判；
 *    2026-09-05 被埋六天的那条真品（卖家把作品名缩写成「冴えカノ♭」）就死在这一行。
 * 3. variant / bundle 不再仅凭字面预判跳过消歧。bundle 来自标题上的「セット」正则，
 *    一件商品的包装清单和三件商品的套装，在标题层根本分不开。
 * 4. 模型的自评 confidence: "high" 不再单独构成确认或拒绝的依据。确认要么靠确定性
 *    证据，要么靠模型给出的原文引用；拒绝同理——计划 §1.3 把「用模型 high confidence
 *    代替证据」列为明令禁止的捷径。
 *
 * 保留的是一条：**程序能证明的冲突仍然直接定案**，不需要等模型翻案。
 */
export function exactProductIdentityDecision(
  input: ExactIdentityDecisionInput,
): ExactIdentityDecision {
  const { relation, output, match } = input;
  const difference = match?.difference;
  const conflicts = match?.conflicts ?? [];
  const conflictingFields = difference?.conflicting ?? [];
  const hasCounterEvidence = conflictingFields.length > 0 || conflicts.length > 0;
  // 候选多出来的区分性标记（バレンタインver.、10個入りBOX、マルイ限定……）
  // 阻止确定性确认。“目标的每个词候选都有”不等于“它就是那件商品”：一个比目标
  // 更具体的候选同样可能是兄弟款。2026-09-12 回放 T5 时，正是这一条把不同活动、
  // 不同角色组合、甚至整盒 BOX 全部当成了确认同款。
  //
  // 它不是反证，所以不拒绝；它只说明字面还没证明身份，该交给语义复核。
  const extraDistinguishers = difference?.extraDistinguishers ?? [];
  const identityProven = difference !== undefined
    && difference.missing.length === 0
    && difference.conflicting.length === 0
    && extraDistinguishers.length === 0;
  // 一个身份要素都没命中，且匹配器也判了 irrelevant：这是程序可证明的「无重叠」。
  const noIdentityOverlap = relation === "irrelevant"
    && difference !== undefined
    && difference.matched.length === 0;

  const aiItemStatus: ExactIdentityAiItemStatus = input.aiItemStatus
    ?? (output ? "ready" : "not_executed");
  const aiExecuted = aiItemStatus !== "not_executed";
  const aiValid = aiItemStatus === "ready" && output !== undefined;
  const relevance = aiValid ? output.relevance : undefined;
  const modelConfidence: "high" | "medium" | "low" = aiValid
    && (output.confidence === "high" || output.confidence === "medium")
    ? output.confidence
    : "low";
  // §8.3 第 5 行：模型自称 different_product，但引用无效或只说缺字段 → uncertain。
  // 确认同理，要求它指得出原文。引用存在不等于引用支持（§5.6），但引用不存在
  // 一定不构成证据。
  const aiCited = aiValid && quotedEvidenceCount(output) > 0;
  const saleRelation = saleRelationOf(relation, aiValid ? output : undefined);

  const settle = (
    decision: ExactIdentityDecision["decision"],
    decisionSource: ExactIdentityDecision["decisionSource"],
    confidence: ExactIdentityDecision["confidence"],
    reasonCode: ExactIdentityReasonCode,
    processingStatus: ExactIdentityProcessingStatus = "complete",
  ): ExactIdentityDecision => ({
    decision,
    decisionSource,
    confidence,
    reasonCode,
    processingStatus,
    saleRelation,
  });

  // 1) 程序可核查的冲突。这是反证，可以定案，不必等模型。
  if (hasCounterEvidence) {
    return settle(
      "rejected",
      "workflow_matcher",
      hardConflict(conflicts) || hardConflict(conflictingFields) ? "high" : "medium",
      "deterministic_conflict",
    );
  }

  // 2) 与目标毫无身份重叠。同样是程序可证明的结论，不是「还没看」。
  if (noIdentityOverlap) {
    return settle("rejected", "workflow_matcher", "high", "no_identity_anchor");
  }

  // 3) 模型执行出了技术问题：缺条、重复、错位、契约不合。
  //    不得默认成 high 置信度的业务结论，更不得算作已排除。
  if (aiExecuted && !aiValid) {
    return settle("uncertain", "workflow_ai", "low", "model_output_invalid", "failed");
  }

  // 4) 模型给出带引用的不同商品结论 → 有据拒绝。
  if (relevance === "irrelevant") {
    return aiCited
      ? settle("rejected", "workflow_ai", modelConfidence, "semantic_different_product")
      : settle("uncertain", "workflow_ai", "low", "identity_evidence_missing", "pending_action");
  }

  // 5) 路径 A（计划 §8.2）：来源可追溯的 JAN / 型号命中，且无冲突。
  //    这里只认逐字核对过的 "JAN" / "型号"，不认来源索引推断出的那一条
  //    （它自己的理由就写着「等待详情字段复核」）。bundle 也不走这条：
  //    整箱 JAN 和单枚对象可能不是同一件东西。
  const identifierProven = (match?.matchedFields ?? []).some((field) => field === "JAN" || field === "型号");
  if (identifierProven && relation !== "bundle") {
    return settle("confirmed", "workflow_matcher", "high", "identifier_match");
  }

  // 6) 确定性证据已经证明身份，且无冲突。套装与缺件描述的是品相与包装，
  //    不再作为身份拦截条件（2026-09-05 的教训）。标题层判为 bundle 的除外：
  //    那一条的销售对象还没判清，见下一步。
  if (identityProven && relation !== "bundle") {
    return settle("confirmed", "workflow_matcher", "high", "deterministic_identity_proven");
  }

  // 7) 模型给出带引用的同款结论。
  //    早期 related / uncertain 不再阻止提升——这正是 §8.5 要求取消的短路。
  //    例外：候选缺了目标的纯符号版本标记（`♭`）。候选文本里没有它，引用就不可能
  //    支持它；2026-10-11 两件 Fes. Fine 正是这样被模型"带引用"确认成 ♭ 版的。
  //    品类词同理：2026-10-12 模型自己写着「贴纸」，仍把它确认成了 ミニ色紙 的同款。
  const missingVersionMarker = (difference?.missingVersionMarkers ?? []).length > 0;
  const missingProductType = Boolean(difference?.missingProductType);
  if (relevance === "relevant" && aiCited && !missingVersionMarker && !missingProductType) {
    if (saleRelation !== "target_unit") {
      return settle("uncertain", "workflow_ai", modelConfidence, "sale_unit_unresolved", "pending_action");
    }
    return settle("confirmed", "workflow_ai", modelConfidence, "semantic_same_product");
  }

  // 8) 其余一律未决，并写清缺的是哪一段。
  //    这一行就是降档记录的全部价值（AGENTS.md §4）：写不出具体缺了什么，
  //    等于没降档。所以优先级是“销售对象没判清” > “模型说证据不足” >
  //    “标题缺身份词、详情没读” > “这一条根本还没送过模型”。
  if (saleRelation !== "target_unit" && (identityProven || identifierProven || relevance === "relevant")) {
    return settle("uncertain", "workflow_ai", modelConfidence, "sale_unit_unresolved", "pending_action");
  }
  if (aiValid) {
    return settle("uncertain", "workflow_ai", modelConfidence, "identity_evidence_missing", "pending_action");
  }
  return settle(
    "uncertain",
    "workflow_matcher",
    "low",
    extraDistinguishers.length > 0
      ? "candidate_has_extra_distinguisher"
      : difference && difference.missing.length > 0
        ? "candidate_detail_required"
        : "model_not_executed",
    "pending_action",
  );
}

