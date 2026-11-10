import { clampInteger } from "./logic.ts";

export interface EmbedTarget {
  card: boolean;
  marketId: string | null;
}

const MARKET_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MARKET_ID_MAX_LENGTH = 128;

function firstValue(query: Record<string, string[]> | URLSearchParams, key: string): string | null {
  if (query instanceof URLSearchParams) {
    return query.get(key);
  }
  const values = query[key];
  return Array.isArray(values) && values.length > 0 ? values[0] : null;
}

function hasValue(query: Record<string, string[]> | URLSearchParams, key: string): boolean {
  if (query instanceof URLSearchParams) {
    return query.has(key);
  }
  const values = query[key];
  return Array.isArray(values) && values.length > 0;
}

/**
 * 读取嵌入卡片启动参数。不信任任何参数：marketId 限制长度与字符集，
 * 非法时按缺失处理（空态），避免把任意输入拼进 iframe 地址。
 */
export function readEmbedTarget(
  query: Record<string, string[]> | URLSearchParams
): EmbedTarget {
  const rawMarket = firstValue(query, "market");
  const marketId =
    rawMarket &&
    rawMarket.length > 0 &&
    rawMarket.length <= MARKET_ID_MAX_LENGTH &&
    MARKET_ID_PATTERN.test(rawMarket)
      ? rawMarket
      : null;
  const card =
    hasValue(query, "card") || hasValue(query, "market") || hasValue(query, "embed_mode");
  return { card, marketId };
}

/** 嵌入卡片高度：基础 260 + 每个结果 44，340–640 区间。 */
export function cardHeight(outcomeCount: number): number {
  const count = Number.isFinite(outcomeCount)
    ? clampInteger(outcomeCount, 0, 12)
    : 0;
  return Math.min(640, Math.max(340, 260 + count * 44));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface EmbedSnippetOptions {
  appOrigin: string;
  appId: string;
  marketId: string;
  title: string;
  height: number;
}

/** 生成供帖子粘贴的一行 iframe 嵌入代码。 */
export function buildEmbedSnippet(options: EmbedSnippetOptions): string {
  const safeHeight =
    Number.isSafeInteger(options.height) && options.height > 0
      ? options.height
      : cardHeight(0);
  const src = `${options.appOrigin}/${options.appId}?embed_mode=true&card=1&market=${encodeURIComponent(
    options.marketId
  )}`;
  const title = `预言鲸 · ${options.title}`;
  return `<iframe src="${src}" title="${escapeHtmlAttribute(title)}" width="100%" height="${safeHeight}" frameborder="0" allow="clipboard-write" loading="lazy"></iframe>`;
}
