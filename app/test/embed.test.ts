import { describe, expect, test } from "bun:test";
import {
  buildEmbedSnippet,
  cardHeight,
  readEmbedTarget,
} from "../src/embed.ts";
import { APP_ID, APP_ORIGIN } from "../src/config.ts";

function queryOf(
  entries: Record<string, string | string[]>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      Array.isArray(value) ? value : [value],
    ])
  );
}

describe("readEmbedTarget", () => {
  test("card 模式由 card / market / embed_mode 任一参数触发", () => {
    expect(readEmbedTarget(queryOf({ card: "1" }))).toEqual({
      card: true,
      marketId: null,
    });
    expect(readEmbedTarget(queryOf({ embed_mode: "true" }))).toEqual({
      card: true,
      marketId: null,
    });
    expect(readEmbedTarget(queryOf({ market: "m_1" }))).toEqual({
      card: true,
      marketId: "m_1",
    });
  });

  test("market 取第一个值", () => {
    expect(readEmbedTarget(queryOf({ card: "1", market: ["a", "b"] }))).toEqual(
      { card: true, marketId: "a" }
    );
  });

  test("market 为空串视为 null", () => {
    expect(readEmbedTarget(queryOf({ card: "1", market: "" }))).toEqual({
      card: true,
      marketId: null,
    });
  });

  test("marketId 超长或含非法字符时回落 null", () => {
    expect(readEmbedTarget(queryOf({ market: "x".repeat(129) })).marketId).toBe(
      null
    );
    expect(readEmbedTarget(queryOf({ market: "../etc" })).marketId).toBe(null);
    expect(readEmbedTarget(queryOf({ market: "m 1" })).marketId).toBe(null);
    expect(readEmbedTarget(queryOf({ market: "合法 id" })).marketId).toBe(null);
    expect(readEmbedTarget(queryOf({ market: "m_ok-1.2" })).marketId).toBe(
      "m_ok-1.2"
    );
  });

  test("无相关参数时非卡片模式", () => {
    expect(readEmbedTarget(queryOf({ demo: "1" }))).toEqual({
      card: false,
      marketId: null,
    });
  });

  test("同时兼容 URLSearchParams", () => {
    const params = new URLSearchParams("card=1&market=m_ok");
    expect(readEmbedTarget(params)).toEqual({
      card: true,
      marketId: "m_ok",
    });
    expect(readEmbedTarget(new URLSearchParams("market=")).marketId).toBe(null);
  });
});

describe("cardHeight", () => {
  test("0 个结果时取下限 340，随结果数增长，12 个及以上封顶 640", () => {
    expect(cardHeight(0)).toBe(340);
    expect(cardHeight(2)).toBe(348);
    expect(cardHeight(5)).toBe(480);
    expect(cardHeight(12)).toBe(640);
    expect(cardHeight(20)).toBe(640);
  });

  test("负数与非有限值按 0 处理", () => {
    expect(cardHeight(-3)).toBe(340);
    expect(cardHeight(Number.NaN)).toBe(340);
  });
});

describe("buildEmbedSnippet", () => {
  const base = {
    appOrigin: APP_ORIGIN,
    appId: APP_ID,
    marketId: "m_v5_when",
    title: "V5 什么时候发布？",
    height: 480,
  };

  test("生成一行 iframe，包含 src、title、尺寸与权限", () => {
    const html = buildEmbedSnippet(base);
    expect(html).toContain('src="https://linux.do/apps/00000000-0000-7000-8000-000000000000?embed_mode=true&card=1&market=m_v5_when"');
    expect(html).toContain('title="预言鲸 · V5 什么时候发布？"');
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="480"');
    expect(html).toContain('frameborder="0"');
    expect(html).toContain('allow="clipboard-write"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("\n");
  });

  test("marketId 与 title 中的 HTML 特殊字符被转义", () => {
    const html = buildEmbedSnippet({
      ...base,
      marketId: "a&b",
      title: '带"引号"与<b>标签</b>的市场',
    });
    expect(html).toContain("market=a%26b");
    expect(html).toContain('title="预言鲸 · 带&quot;引号&quot;与&lt;b&gt;标签&lt;/b&gt;的市场"');
  });

  test("非法高度回落 cardHeight(0)", () => {
    expect(buildEmbedSnippet({ ...base, height: 0 })).toContain('height="340"');
    expect(buildEmbedSnippet({ ...base, height: -100 })).toContain(
      'height="340"'
    );
    expect(buildEmbedSnippet({ ...base, height: 1.5 })).toContain(
      'height="340"'
    );
    expect(buildEmbedSnippet({ ...base, height: Number.NaN })).toContain(
      'height="340"'
    );
  });
});
