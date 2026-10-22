/**
 * "来源页面结构变了"的唯一判据。
 *
 * 通用解析器报 `parser_structure_error`；煤炉、骏河屋、雅虎商城等有自己的错误类，
 * 报 `<来源>_schema_changed`。两种都是"请求成功了但读不懂"，不是网络或被拦。
 * 以前健康快照、行情分析、失败冷却各写一份，健康快照漏了后一种，
 * 把结构变化记成了普通 failed（docs/研究/三种空与解析失败率-排查-20261011.md）。
 */
export function isParserFailureCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return code === "parser_structure_error" || code.endsWith("_schema_changed");
}
