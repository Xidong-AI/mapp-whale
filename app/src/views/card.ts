import { t } from "../copy.ts";
import type { AppContext } from "../context.ts";
import { clear, el, makeIcon } from "../dom.ts";
import { describeError } from "../errors.ts";
import {
  formatChips,
  impliedPercent,
  marketPoolTotal,
} from "../logic.ts";
import { deadlineView, marketStatus } from "../market-status.ts";
import type { Market } from "../types.ts";

export interface CardView {
  show(marketId: string | null): Promise<void>;
}

function stateGlyph(ref: string): SVGSVGElement {
  const glyph = makeIcon(ref);
  glyph.classList.add("card__glyph");
  return glyph;
}

function paintEmpty(root: HTMLElement): void {
  clear(root);
  const empty = el("div", "card__empty");
  empty.setAttribute("role", "status");
  empty.append(
    stateGlyph("i-whale"),
    el("strong", "card__empty-title", t("card.emptyTitle")),
    el("span", "card__empty-hint", t("card.emptyHint"))
  );
  root.append(empty);
}

function paintError(root: HTMLElement, message: string, retry: () => void): void {
  clear(root);
  const error = el("div", "card__error");
  error.setAttribute("role", "alert");
  error.append(
    stateGlyph("i-whale"),
    el("strong", "card__error-title", t("card.errorTitle")),
    el("span", "card__error-text", message)
  );
  const button = el("button", "ghost card__retry");
  button.type = "button";
  button.append(
    makeIcon("i-refresh"),
    el("span", "card__retry-label", t("card.retry"))
  );
  button.addEventListener("click", retry);
  error.append(button);
  root.append(error);
}

function paintLoading(root: HTMLElement): void {
  clear(root);
  const loading = el("div", "card card--loading");
  loading.setAttribute("role", "status");
  const spinner = el("span", "spinner");
  spinner.setAttribute("aria-hidden", "true");
  loading.append(spinner, el("span", "card__loading-text", t("card.loading")));
  root.append(loading);
}

function paintMarket(root: HTMLElement, market: Market, now: number): void {
  clear(root);
  const card = el("article", "card");
  card.setAttribute("aria-labelledby", "card-title");

  const brand = el("span", "card__brand");
  const mark = makeIcon("i-whale");
  mark.classList.add("card__mark");
  brand.append(mark, el("span", "card__brand-name", t("card.brand")));
  card.append(brand);

  const title = el("h1", "card__title", market.title);
  title.id = "card-title";
  card.append(title);

  const meta = el("div", "card__meta");
  const status = marketStatus(market, now);
  const tag = el("span", `tag tag--${status.tone}`);
  const dot = el("i");
  dot.setAttribute("aria-hidden", "true");
  tag.append(dot, document.createTextNode(status.label));
  const deadline = el("span", "card__deadline");
  const clock = makeIcon("i-clock");
  clock.classList.add("card__clock");
  deadline.append(
    clock,
    el("span", "card__deadline-text", deadlineView(market, now).text)
  );
  meta.append(tag, deadline);
  card.append(meta);

  const dist = el("div", "card__dist");
  dist.setAttribute("role", "list");
  dist.setAttribute("aria-label", t("card.distAria"));
  const ranked = [...market.outcomes].sort(
    (left, right) => right.implied - left.implied
  );
  if (ranked.length >= 5) dist.classList.add("is-dense");
  ranked.forEach((outcome, index) => {
    const row = el("div", "card__row");
    row.setAttribute("role", "listitem");
    if (index === 0) row.classList.add("is-top");
    row.style.setProperty("--i", String(index));
    const head = el("div", "card__row-head");
    const name = el("span", "card__name", outcome.label);
    name.title = outcome.label;
    head.append(
      name,
      el("b", "card__pct num", `${impliedPercent(outcome.implied)}%`)
    );
    const bar = el("div", "card__bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("i");
    fill.style.width = `${impliedPercent(outcome.implied)}%`;
    bar.append(fill);
    row.append(head, bar);
    dist.append(row);
  });
  card.append(dist);

  const foot = el("div", "card__foot");
  const pool = el("span", "card__pool");
  pool.append(
    el("span", "card__foot-label", t("card.pool")),
    el("b", "card__pool-value num", formatChips(marketPoolTotal(market)))
  );
  foot.append(pool);
  if (market.participants) {
    foot.append(
      el("span", "card__join", t("card.participants", { count: market.participants }))
    );
  }
  card.append(foot);

  root.append(card);
}

export function createCardView(ctx: AppContext): CardView {
  const root = document.getElementById("view-card");
  if (!root) throw new Error("Missing element #view-card");
  const viewRoot: HTMLElement = root;
  let token = 0;

  async function load(marketId: string, mine: number): Promise<void> {
    paintLoading(viewRoot);
    try {
      const page = await ctx.api.markets({ id: marketId });
      if (token !== mine) return;
      const market = page.items[0] ?? null;
      if (!market) {
        paintEmpty(viewRoot);
        return;
      }
      paintMarket(viewRoot, market, ctx.serverNow());
    } catch (error) {
      if (token !== mine) return;
      paintError(viewRoot, describeError(error), () => {
        token += 1;
        void load(marketId, token);
      });
    }
  }

  return {
    async show(marketId: string | null): Promise<void> {
      token += 1;
      const mine = token;
      if (!marketId) {
        paintEmpty(root);
        return;
      }
      await load(marketId, mine);
    },
  };
}
