import { integer, record, text } from "../http.js";
import { YahooExperimentalError } from "./errors.js";

const NEXT_DATA_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const NEXT_DATA_ID = /\bid\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__')/i;
const EXPLICIT_NO_RESULTS_MARKER = "商品が見つかりません";

export interface YahooParsedPage {
  items: Record<string, unknown>[];
  nextUrl?: string;
  totalAvailable?: number;
  totalPages?: number;
  warnings: string[];
}

function challengeError(html: string): YahooExperimentalError | undefined {
  const sample = html.slice(0, 200_000).toLowerCase();
  if (sample.includes("captcha") || sample.includes("ロボットではない") || sample.includes("画像認証")) {
    return new YahooExperimentalError("Yahoo 返回了 CAPTCHA，实验来源已失败关闭", "yahoo_captcha", 403, false, 60 * 60);
  }
  if (sample.includes("ログインしてください")) {
    return new YahooExperimentalError("Yahoo 当前要求登录，实验来源已失败关闭", "yahoo_login_required", 403, false, 60 * 60);
  }
  return undefined;
}

export function extractYahooNextData(html: string): Record<string, unknown> {
  const challenge = challengeError(html);
  if (challenge) throw challenge;

  NEXT_DATA_SCRIPT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEXT_DATA_SCRIPT.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    if (!NEXT_DATA_ID.test(attributes)) continue;
    const source = match[2]?.trim();
    if (!source) break;
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return record(parsed);
    } catch {
      throw new YahooExperimentalError("Yahoo __NEXT_DATA__ 不是合法 JSON", "yahoo_schema_changed", 502);
    }
    break;
  }
  throw new YahooExperimentalError("Yahoo 搜索页缺少 __NEXT_DATA__", "yahoo_next_data_missing", 502);
}

function resultContainer(mapping: Record<string, unknown>, page: number): { value: Record<string, unknown>; warning?: string } {
  const preferred = record(mapping.searchResults);
  const preferredItems = record(preferred.items);
  if (Object.hasOwn(preferredItems, String(page)) || Object.keys(preferredItems).length === 1) return { value: preferred };

  for (const [key, candidate] of Object.entries(mapping)) {
    if (key === "searchResults" || !key.startsWith("searchResults")) continue;
    const value = record(candidate);
    const items = record(value.items);
    if (Object.hasOwn(items, String(page)) || Object.keys(items).length === 1) {
      return { value, warning: `Yahoo 使用了兼容结果容器 ${key}` };
    }
  }
  throw new YahooExperimentalError(`Yahoo 第 ${page} 页缺少 searchResults 容器`, "yahoo_schema_changed", 502);
}

function pageModules(container: Record<string, unknown>, page: number): { modules: Record<string, unknown>[]; warning?: string } {
  const pages = record(container.items);
  let value = pages[String(page)];
  let warning: string | undefined;
  if (value === undefined && Object.keys(pages).length === 1) {
    value = Object.values(pages)[0];
    warning = `Yahoo 第 ${page} 页使用了唯一页码容器兼容解析`;
  }
  if (!Array.isArray(value)) {
    throw new YahooExperimentalError(`Yahoo 第 ${page} 页缺少模块数组`, "yahoo_schema_changed", 502);
  }
  return {
    modules: value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry)),
    warning,
  };
}

export function parseYahooResultPage(mapping: Record<string, unknown>, page: number): YahooParsedPage {
  const container = resultContainer(mapping, page);
  const parsedModules = pageModules(container.value, page);
  const result = parsedModules.modules.find((module) => module.type === "RESULT");
  const pager = parsedModules.modules.find((module) => module.type === "PAGER");
  const resultContent = record(result?.content);
  if (!result || !Array.isArray(resultContent.items)) {
    throw new YahooExperimentalError(`Yahoo 第 ${page} 页缺少 RESULT 商品数组`, "yahoo_schema_changed", 502);
  }

  const pagerContent = record(pager?.content);
  const nextValue = record(pagerContent.nextUrl);
  const nextUrl = text(nextValue.url) ?? text(pagerContent.next);
  const warnings = [container.warning, parsedModules.warning].filter((value): value is string => Boolean(value));
  const totalAvailable = integer(pagerContent.total);
  const totalPages = integer(pagerContent.totalPage);
  return {
    items: resultContent.items.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry)),
    ...(nextUrl ? { nextUrl } : {}),
    ...(totalAvailable !== undefined && totalAvailable >= 0 ? { totalAvailable } : {}),
    ...(totalPages !== undefined && totalPages >= 0 ? { totalPages } : {}),
    warnings,
  };
}

function isExplicitEmptySearchPage(html: string, bff: Record<string, unknown>): boolean {
  return html.includes(EXPLICIT_NO_RESULTS_MARKER)
    && Object.hasOwn(bff, "searchResults")
    && Object.keys(record(bff.searchResults)).length === 0;
}

export function parseYahooSearchHtml(html: string, page = 1): YahooParsedPage {
  const nextData = extractYahooNextData(html);
  const initialState = record(record(nextData.props).initialState);
  if (Object.keys(initialState).length === 0) {
    throw new YahooExperimentalError("Yahoo __NEXT_DATA__ 缺少 props.initialState", "yahoo_schema_changed", 502);
  }
  const bff = record(initialState.bff);
  return isExplicitEmptySearchPage(html, bff)
    ? {
        items: [],
        totalAvailable: 0,
        totalPages: 0,
        warnings: ["Yahoo 明确返回该关键词没有匹配商品。"],
      }
    : parseYahooResultPage(bff, page);
}

export const parseYahooBootstrapHtml = parseYahooSearchHtml;
