import { CACHE_KEYS } from "../cache.ts";
import { CACHE_TTL } from "../config.ts";
import { PAGE_SIZE } from "../config.ts";
import type { AppContext } from "../context.ts";
import { t } from "../copy.ts";
import { byId, clear, el, setText, show, statusTag } from "../dom.ts";
import { describeError } from "../errors.ts";
import {
  formatChips,
  formatDateTime,
  formatMultiplier,
  impliedPercent,
  marketPoolTotal,
  sortMarkets,
} from "../logic.ts";
import { deadlineView, marketStatus } from "../market-status.ts";
import type { Market } from "../types.ts";

export interface MarketsView {
  load(force?: boolean): Promise<void>;
  refresh(): void;
}

interface CachedMarkets {
  items: Market[];
}

export function createMarketsView(ctx: AppContext): MarketsView {
  const list = byId("markets-list");
  const loadingEl = byId("markets-loading");
  const emptyEl = byId("markets-empty");
  const errorEl = byId("markets-error");
  const errorText = byId("markets-error-text");
  const refreshButton = byId<HTMLButtonElement>("markets-refresh");
  const moreButton = byId<HTMLButtonElement>("markets-more");
  const errorRetry = byId<HTMLButtonElement>("markets-error-retry");
  const summaryPool = byId("summary-pool");
  const summaryOpen = byId("summary-open");
  const summarySeason = byId("summary-season");
  const eyebrow = byId("markets-eyebrow");
  const footerSeason = byId("footer-season");

  let loading = false;
  let error: string | null = null;
  let hasMore = false;
  let cursor: string | null = null;
  let lastFetch = 0;
  let inFlight = false;
  let lastSignature = "";

  function cachedAt(): number {
    const cached = ctx.cache.read<CachedMarkets>(CACHE_KEYS.markets);
    return Date.now() - (cached?.age ?? 0);
  }

  function createCard(market: Market): HTMLElement {
    const now = ctx.serverNow();
    const card = el("article", "market-card");
    const status = marketStatus(market, now);
    const deadline = deadlineView(market, now);
    card.dataset.status = status.edge;
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute(
      "aria-label",
      t("markets.cardAria", {
        title: market.title,
        status: status.label,
        time: formatDateTime(market.deadline),
      })
    );

    const open = () => ctx.openMarket(market.id);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    const head = el("header", "market-card__head");
    const countdown = el("span", "countdown");
    countdown.textContent = deadline.text;
    if (deadline.closed) countdown.classList.add("countdown--closed");
    if (market.status === "open" || market.status === "locked") {
      countdown.dataset.countdown = String(market.deadline);
      countdown.dataset.countdownPrefix = "left";
    }
    head.append(statusTag(status.label, status.tone), countdown);

    const title = el("h2", "market-card__title");
    title.textContent = market.title;

    const desc = el("p", "market-card__desc");
    desc.textContent = market.description;

    const yes = impliedPercent(market.impliedYes);
    const consensus = el("div", "consensus-mini");
    const bar = el("div", "consensus-mini__bar");
    const yesBar = el("span");
    yesBar.style.width = `${yes}%`;
    bar.append(yesBar);
    const labels = el("div", "consensus-mini__labels");
    const yesLabel = el("span");
    yesLabel.append(
      document.createTextNode(`${t("detail.sideYes")} `),
      Object.assign(el("b"), { textContent: `${yes}%` })
    );
    const noLabel = el("span");
    noLabel.append(
      document.createTextNode(`${t("detail.sideNo")} `),
      Object.assign(el("b"), { textContent: `${100 - yes}%` })
    );
    labels.append(yesLabel, noLabel);
    consensus.append(bar, labels);

    const quotes = el("dl", "market-card__quotes");
    const yesChip = el("div", "quote-chip quote-chip--yes");
    yesChip.append(
      Object.assign(el("dt"), {
        textContent: `${t("detail.multiplier")} · ${t("detail.sideYes")}`,
      }),
      Object.assign(el("dd"), { textContent: formatMultiplier(market.payoutYes) })
    );
    const noChip = el("div", "quote-chip quote-chip--no");
    noChip.append(
      Object.assign(el("dt"), {
        textContent: `${t("detail.multiplier")} · ${t("detail.sideNo")}`,
      }),
      Object.assign(el("dd"), { textContent: formatMultiplier(market.payoutNo) })
    );
    quotes.append(yesChip, noChip);

    const foot = el("footer", "market-card__foot");
    const pool = el("span");
    pool.append(
      document.createTextNode(`${t("markets.pool")} `),
      Object.assign(el("b"), {
        textContent: formatChips(marketPoolTotal(market)),
      })
    );
    foot.append(pool);

    const marks = el("span", "market-card__marks");
    if (market.participants !== null && market.participants !== undefined) {
      marks.append(
        el(
          "span",
          "",
          t("markets.participants", {
            count: formatChips(market.participants),
          })
        )
      );
    }
    if (ctx.getPrefs().lastMarketId === market.id) {
      marks.append(el("span", "last-seen", t("markets.lastViewed")));
    }
    if (marks.childElementCount > 0) foot.append(marks);

    card.append(head, title, desc, consensus, quotes, foot);
    return card;
  }

  function render(): void {
    const now = ctx.serverNow();
    const markets = sortMarkets(ctx.getMarkets());
    const signature = `${ctx.getPrefs().lastMarketId ?? ""}|${JSON.stringify(
      markets.map((market) => [
        market.id,
        market.title,
        market.description,
        market.deadline,
        market.status,
        market.outcome,
        market.yesPool,
        market.noPool,
        market.seedYes,
        market.seedNo,
        market.yesShare,
        market.impliedYes,
        market.payoutYes,
        market.payoutNo,
        market.hitCount,
        market.firstSeenAt,
        market.settledAt,
        market.settleReason,
        market.participants,
      ])
    )}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      clear(list);
      for (const market of markets) {
        list.append(createCard(market));
      }
    }

    const config = ctx.getConfig();
    const season = config.season || "—";
    const total = markets.reduce((sum, market) => sum + marketPoolTotal(market), 0);
    setText(summaryPool, markets.length > 0 ? formatChips(total) : "—");
    setText(
      summaryOpen,
      markets.length > 0
        ? String(markets.filter((market) => market.status === "open").length)
        : "—"
    );
    setText(summarySeason, season);
    setText(eyebrow, t("markets.eyebrow", { season }));
    setText(footerSeason, config.season ? t("meta.seasonLine", { season }) : "");

    show(loadingEl, loading && markets.length === 0);
    show(emptyEl, !loading && !error && markets.length === 0);
    show(errorEl, Boolean(error) && markets.length === 0);
    show(moreButton, hasMore && markets.length > 0 && !loading);
    setText(errorText, error ?? t("markets.errorBody"));
    moreButton.disabled = loading;
  }

  async function load(force = false): Promise<void> {
    if (inFlight) return;

    const cached = ctx.cache.read<CachedMarkets>(
      CACHE_KEYS.markets,
      CACHE_TTL.markets
    );
    if (cached && Array.isArray(cached.value?.items)) {
      ctx.setMarkets(cached.value.items);
    }

    if (
      !force &&
      ctx.getMarkets().length > 0 &&
      Date.now() - lastFetch < CACHE_TTL.markets
    ) {
      render();
      return;
    }

    inFlight = true;
    loading = true;
    error = null;
    refreshButton.disabled = true;
    render();

    try {
      const limit = ctx.getConfig().pageSize ?? PAGE_SIZE;
      const page = await ctx.api.markets({ limit });
      ctx.setMarkets(page.items);
      cursor = page.nextCursor;
      hasMore = Boolean(page.nextCursor);
      error = null;
      lastFetch = Date.now();
      ctx.cache.write(CACHE_KEYS.markets, { items: page.items });
      ctx.banner(null);
    } catch (cause) {
      const message = describeError(cause);
      if (ctx.getMarkets().length > 0) {
        ctx.banner(
          t("common.offlineData", { time: formatDateTime(cachedAt()) }),
          { tone: "offline", retry: () => void load(true) }
        );
        error = null;
      } else {
        error = message;
        ctx.banner(null);
      }
    } finally {
      inFlight = false;
      loading = false;
      refreshButton.disabled = false;
      render();
    }
  }

  async function loadMore(): Promise<void> {
    if (inFlight || !cursor) return;
    inFlight = true;
    loading = true;
    moreButton.disabled = true;
    render();
    try {
      const limit = ctx.getConfig().pageSize ?? PAGE_SIZE;
      const page = await ctx.api.markets({ limit, cursor });
      const seen = new Set(ctx.getMarkets().map((market) => market.id));
      const merged = [...ctx.getMarkets()];
      for (const market of page.items) {
        if (!seen.has(market.id)) {
          seen.add(market.id);
          merged.push(market);
        }
      }
      ctx.setMarkets(merged);
      cursor = page.nextCursor;
      hasMore = Boolean(page.nextCursor);
      ctx.cache.write(CACHE_KEYS.markets, { items: merged });
      lastFetch = Date.now();
    } catch (cause) {
      ctx.toast(describeError(cause), "error");
    } finally {
      inFlight = false;
      loading = false;
      render();
    }
  }

  refreshButton.addEventListener("click", () => void load(true));
  moreButton.addEventListener("click", () => void loadMore());
  errorRetry.addEventListener("click", () => void load(true));

  return {
    load,
    refresh: render,
  };
}
