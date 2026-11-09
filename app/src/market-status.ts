import { t } from "./copy.ts";
import { formatCountdown, formatDateTime } from "./logic.ts";
import type { Market } from "./types.ts";

export type StatusTone = "open" | "locked" | "settled" | "void" | "yes" | "no";

export interface MarketStatusView {
  tone: StatusTone;
  label: string;
  edge: string;
}

export function marketStatus(
  market: Market,
  now: number
): MarketStatusView {
  if (market.status === "settled") {
    const winner = market.outcomes.find(
      (outcome) => outcome.id === market.winningOutcomeId
    );
    if (winner) {
      return {
        tone: "yes",
        edge: "settled",
        label: `${t("status.settled")} · ${winner.label}`,
      };
    }
    return { tone: "void", edge: "void", label: t("status.settled") };
  }
  if (market.status === "void") {
    return { tone: "void", edge: "void", label: t("status.void") };
  }
  if (market.status === "settling") {
    return { tone: "locked", edge: "locked", label: t("status.settling") };
  }
  if (market.status === "locked" || market.deadline <= now) {
    return { tone: "locked", edge: "locked", label: t("status.locked") };
  }
  return { tone: "open", edge: "open", label: t("status.open") };
}

export interface DeadlineView {
  text: string;
  closed: boolean;
}

export function deadlineView(market: Market, now: number): DeadlineView {
  if (market.status === "settled" || market.status === "void") {
    return {
      text: t("markets.settledAt", {
        time: formatDateTime(market.settledAt ?? market.deadline),
      }),
      closed: true,
    };
  }
  if (market.status === "settling") {
    return { text: t("markets.deadlineClosed"), closed: true };
  }
  const value = formatCountdown(market.deadline, now, true);
  if (value === "已截止") {
    return { text: t("markets.deadlineClosed"), closed: true };
  }
  return {
    text: t("markets.deadlineLeft", { time: value }),
    closed: false,
  };
}
