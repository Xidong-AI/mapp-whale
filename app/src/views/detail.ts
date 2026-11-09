import { CACHE_KEYS } from "../cache.ts";
import { t } from "../copy.ts";
import type { AppContext } from "../context.ts";
import { byId, clear, el, makeIcon, setText, show } from "../dom.ts";
import {
  ApiError,
  describeError,
  errorCode,
  isOfflineError,
} from "../errors.ts";
import {
  applyOutcomePools,
  betIntentKey,
  betLimit,
  clampInteger,
  formatChips,
  formatConfidence,
  formatDateTime,
  formatMultiplier,
  impliedPercent,
  marketPoolTotal,
  previewReturn,
  quickAmount,
  sideFor,
  stageFor,
  stageHint,
  validateAmount,
  type AmountCheck,
} from "../logic.ts";
import { deadlineView, marketStatus } from "../market-status.ts";
import type { BetDraft, Market } from "../types.ts";

export interface DetailView {
  open(id: string): Promise<void>;
  refresh(): void;
  tick(): void;
}

function amountMessage(check: AmountCheck): string {
  switch (check.code) {
    case "BET_TOO_SMALL":
      return t("errors.betTooSmall", { min: check.min });
    case "BET_TOO_LARGE":
      return t("errors.betTooLarge", { max: check.max });
    case "CHIPS_TOO_LOW":
      return t("errors.chipsTooLow");
    case "INVALID_AMOUNT":
    default:
      return t("errors.invalidAmount");
  }
}

function shouldKeepRequestId(error: unknown): boolean {
  return isOfflineError(error) || errorCode(error) === "TIMEOUT";
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function createDetailView(ctx: AppContext): DetailView {
  const body = byId("detail-body");
  const loadingEl = byId("detail-loading");
  const errorEl = byId("detail-error");
  const errorText = byId("detail-error-text");
  const detailStatus = byId("detail-status");
  const detailStatusLabel = detailStatus.querySelector("span") as HTMLElement;
  const countdown = byId("detail-countdown");
  const title = byId("detail-title");
  const desc = byId("detail-desc");

  const whale = byId("whale");
  const whaleTitle = byId<HTMLElement>("whale-title");
  const stageIndex = byId("stage-index");
  const stageName = byId("stage-name");
  const stageHintNode = byId("stage-hint");
  const sliderBlock = document.querySelector<HTMLElement>(".slider-block");
  if (!sliderBlock) throw new Error("Missing .slider-block");
  const sliderBlockNode: HTMLElement = sliderBlock;
  const slider = byId<HTMLInputElement>("confidence");
  const confidenceValue = byId("confidence-value");
  const sliderHelp = byId("slider-help");

  const betForm = byId("bet-form");
  const betGate = byId("bet-gate");
  const betClosed = byId("bet-closed");
  const betClosedResult = byId("bet-closed-result");
  const betSide = byId("bet-side");
  const amountInput = byId<HTMLInputElement>("amount");
  const amountHint = byId("amount-hint");
  const betHint = byId("bet-hint");
  const submitButton = byId<HTMLButtonElement>("submit-bet");
  const quoteMultiplier = byId("quote-multiplier");
  const quoteReturn = byId("quote-return");

  const outcomePicker = el("div", "outcome-picker");
  betForm.parentElement?.insertBefore(outcomePicker, betForm);

  const consensusYes = byId("consensus-yes");
  const consensusYesLabel = byId("consensus-yes-label");
  const consensusNoLabel = byId("consensus-no-label");
  const consensusPool = byId("consensus-pool");
  const consensusEyebrow = byId("consensus-eyebrow");
  const timelineList = byId("timeline-list");

  const quickButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#quick-amounts [data-quick]")
  );

  let current: Market | null = null;
  let currentId: string | null = null;
  let token = 0;
  let submitting = false;
  const pendingBets = new Map<string, string>();
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let transientHint = "";
  let deadlineHandled = false;
  let selectedOutcomeId: string | null = null;

  function setTransientHint(text: string, tone: "error" | "ok" | "info"): void {
    transientHint = text;
    betHint.textContent = text;
    betHint.classList.toggle("hint--error", tone === "error");
    betHint.classList.toggle("hint--ok", tone === "ok");
  }

  function clearTransientHint(): void {
    transientHint = "";
    betHint.textContent = "";
    betHint.classList.remove("hint--error", "hint--ok");
  }

  function setBetSide(label: string, tone: "yes" | "no" | "idle"): void {
    betSide.className = `tag tag--${tone}`;
    betSide.replaceChildren(
      ...(tone === "idle" ? [] : [makeIcon(tone === "yes" ? "i-up" : "i-down")]),
      document.createTextNode(label)
    );
  }

  function renderOutcomePicker(market: Market): void {
    clear(outcomePicker);
    const preferred = market.outcomes.some(
      (outcome) => outcome.id === selectedOutcomeId
    )
      ? selectedOutcomeId
      : market.outcomes[0]?.id ?? null;
    selectedOutcomeId = preferred;
    for (const outcome of market.outcomes) {
      const button = el("button", "outcome-option") as HTMLButtonElement;
      button.type = "button";
      button.dataset.outcomeId = outcome.id;
      button.classList.toggle("is-selected", outcome.id === preferred);
      button.setAttribute("aria-pressed", String(outcome.id === preferred));
      button.append(
        el("span", "outcome-option__label", outcome.label),
        el(
          "span",
          "outcome-option__meta",
          `${impliedPercent(outcome.implied)}% · ${formatMultiplier(outcome.payout)}`
        )
      );
      button.addEventListener("click", () => {
        selectedOutcomeId = outcome.id;
        renderOutcomePicker(market);
        updateQuote();
        updateSubmit();
        ctx.setPrefs({ lastOutcomeId: outcome.id });
      });
      outcomePicker.append(button);
    }
    outcomePicker.hidden = market.outcomes.length === 0;
  }

  function updateWhale(confidence: number): void {
    const stage = stageFor(confidence);
    whale.dataset.direction = String(stage.direction);
    whale.dataset.stage = String(stage.index);

    const hint = stageHint(stage.direction, stage.index);
    setText(
      stageIndex,
      t("detail.stageIndex", {
        index: String(stage.index + 1).padStart(2, "0"),
      })
    );
    setText(stageName, stage.label);
    setText(stageHintNode, hint);
    whaleTitle.textContent = t("detail.stageAria", {
      label: stage.label,
      hint,
    });

    sliderBlockNode.classList.toggle("is-bear", stage.direction < 0);
    sliderBlockNode.classList.toggle("is-bull", stage.direction > 0);
    const stageNode = whale.closest(".stage");
    stageNode?.classList.toggle("is-bear", stage.direction < 0);
    stageNode?.classList.toggle("is-bull", stage.direction > 0);
    slider.classList.toggle("is-bear", stage.direction < 0);
    slider.classList.toggle("is-bull", stage.direction > 0);
    confidenceValue.textContent = formatConfidence(confidence);

    const selected = current?.outcomes.find(
      (outcome) => outcome.id === selectedOutcomeId
    );
    setBetSide(selected?.label ?? t("detail.pendingSide"), "idle");

    slider.setAttribute(
      "aria-valuetext",
      `${stage.label}，信心 ${Math.abs(confidence)}`
    );
  }

  function currentChips(): number | null {
    const me = ctx.getMe();
    return me ? me.chips : null;
  }

  function amountCheck(): AmountCheck | null {
    const chips = currentChips();
    if (chips === null) return null;
    const config = ctx.getConfig();
    return validateAmount(
      amountInput.value,
      chips,
      config.betMin,
      config.maxBetRatio
    );
  }

  function updateQuote(): void {
    if (!current) return;
    amountInput.min = String(ctx.getConfig().betMin);
    const selected = current.outcomes.find(
      (outcome) => outcome.id === selectedOutcomeId
    );
    const multiplier = selected?.payout ?? 0;
    setText(quoteMultiplier, selected ? formatMultiplier(multiplier) : "—");

    const amount = Number(amountInput.value);
    const validAmount = Number.isSafeInteger(amount) && amount > 0;
    setText(
      quoteReturn,
      selected && validAmount
        ? formatChips(previewReturn(amount, multiplier))
        : "—"
    );

    if (!ctx.isSignedIn()) {
      setText(amountHint, t("detail.gateInline"));
      amountHint.classList.remove("hint--error");
      amountInput.removeAttribute("aria-invalid");
      return;
    }
    const check = amountCheck();
    if (!check) {
      setText(amountHint, t("detail.balancePending"));
      amountHint.classList.remove("hint--error");
      amountInput.removeAttribute("aria-invalid");
      return;
    }
    amountInput.setAttribute("aria-invalid", String(!check.ok));
    amountHint.classList.toggle("hint--error", !check.ok);
    setText(
      amountHint,
      check.ok
        ? t("detail.amountHint", { min: check.min, max: check.max })
        : amountMessage(check)
    );
    amountInput.max = String(Math.max(0, check.max));
  }

  function updateSubmit(): void {
    const signed = ctx.isSignedIn();
    const me = ctx.getMe();
    const selected = current?.outcomes.find(
      (outcome) => outcome.id === selectedOutcomeId
    );
    const check = amountCheck();
    const open =
      Boolean(current) &&
      current!.status === "open" &&
      current!.deadline > ctx.serverNow();

    submitButton.disabled =
      submitting ||
      !signed ||
      !me ||
      !current ||
      !open ||
      !selected ||
      check === null ||
      !check.ok;

    const directionText = "请选择一个结果";
    if (!transientHint && signed && !selected) {
      betHint.textContent = directionText;
    } else if (!transientHint && betHint.textContent === directionText) {
      betHint.textContent = "";
    }
  }

  function updateAll(): void {
    updateWhale(Number(slider.value));
    updateQuote();
    updateSubmit();
    if (current) {
      const now = ctx.serverNow();
      const status = marketStatus(current, now);
      detailStatus.className = `tag tag--${status.tone}`;
      detailStatusLabel.textContent = status.label;
      const deadline = deadlineView(current, now);
      countdown.textContent = deadline.text;
      countdown.classList.toggle("countdown--closed", deadline.closed);
      if (current.status === "open" || current.status === "locked") {
        countdown.dataset.countdown = String(current.deadline);
        countdown.dataset.countdownPrefix = "left";
      } else {
        delete countdown.dataset.countdown;
      }
    }
  }

  function paintConsensus(market: Market): void {
    const first = market.outcomes[0];
    const second = market.outcomes[1];
    const firstPct = impliedPercent(first?.implied ?? 0);
    consensusYes.style.width = `${firstPct}%`;
    setText(consensusYesLabel, `${first?.label ?? "—"} ${firstPct}%`);
    setText(
      consensusNoLabel,
      `${second?.label ?? "—"} ${impliedPercent(second?.implied ?? 0)}%`
    );
    setText(
      consensusPool,
      `总池 ${formatChips(market.totalPool)} · ${market.outcomes.length} 个结果`
    );
    setText(
      consensusEyebrow,
      t("detail.deadlineAt", { time: formatDateTime(market.deadline) })
    );
  }

  function timelineStep(
    label: string,
    detail: string,
    state: "done" | "current" | "future"
  ): HTMLLIElement {
    const item = el("li");
    item.dataset.state = state;
    const dot = el("span", "timeline__dot");
    dot.setAttribute("aria-hidden", "true");
    const bodyNode = el("div", "timeline__body");
    bodyNode.append(el("strong", "", label), el("span", "", detail));
    item.append(dot, bodyNode);
    return item;
  }

  function paintTimeline(market: Market): void {
    const now = ctx.serverNow();
    const settled =
      market.status === "settled" || market.status === "void";
    const outcome =
      market.outcomes.find((item) => item.id === market.winningOutcomeId)?.label ??
      (market.status === "void" ? t("status.void") : "—");
    const steps = [
      timelineStep(
        t("detail.timelineDeadline"),
        t("detail.timelineDeadlineDetail", {
          time: formatDateTime(market.deadline),
        }),
        market.status === "open" && market.deadline > now ? "current" : "done"
      ),
      timelineStep(
        t("detail.timelineWatch"),
        settled ? t("detail.timelineWatchNone") : t("detail.timelineWaiting"),
        settled ? "done" : "future"
      ),
      timelineStep(
        t("detail.timelineSettle"),
        settled
          ? t("detail.timelineSettled", {
              outcome,
              time: formatDateTime(market.settledAt),
            })
          : t("detail.timelineWaiting"),
        settled ? "done" : "future"
      ),
    ];
    clear(timelineList);
    timelineList.append(...steps);
  }

  function paintGates(market: Market): void {
    const open = market.status === "open" && market.deadline > ctx.serverNow();
    if (!open) deadlineHandled = true;
    const signed = ctx.isSignedIn();
    show(betForm, signed && open);
    show(betGate, !signed && open);
    show(betClosed, !open);

    if (!open) {
      const settled =
        market.status === "settled" || market.status === "void";
      const outcome =
        market.outcomes.find((item) => item.id === market.winningOutcomeId)?.label ??
        (market.status === "void" ? t("status.void") : "");
      betClosedResult.textContent = settled
        ? [outcome, formatDateTime(market.settledAt)].filter(Boolean).join(" · ")
        : t("detail.closedWaiting");
    }
  }

  function paintMarket(market: Market, restore: boolean): void {
    current = market;
    deadlineHandled =
      market.status !== "open" || market.deadline <= ctx.serverNow();
    show(body, true);
    show(errorEl, false);
    show(loadingEl, false);
    title.textContent = market.title;
    desc.textContent = market.description;
    setText(sliderHelp, t("detail.sliderHelp"));
    if (restore) restoreInputs(market);
    renderOutcomePicker(market);
    paintConsensus(market);
    paintTimeline(market);
    paintGates(market);
    updateAll();
    ctx.setPrefs({ lastMarketId: market.id });
  }

  function restoreInputs(market: Market): void {
    const config = ctx.getConfig();
    const draft: BetDraft | null = ctx.getDraft();
    const prefs = ctx.getPrefs();
    const preferredOutcome =
      draft && draft.marketId === market.id
        ? draft.outcomeId
        : prefs.lastOutcomeId;
    selectedOutcomeId = market.outcomes.some(
      (outcome) => outcome.id === preferredOutcome
    )
      ? preferredOutcome
      : market.outcomes[0]?.id ?? null;
    let confidence = clampInteger(prefs.confidence, -100, 100);
    let amount = prefs.amount ?? config.betMin;
    let restored = false;
    if (draft && draft.marketId === market.id && draft.confidence !== 0) {
      confidence = clampInteger(draft.confidence, -100, 100);
      amount = draft.amount ?? amount;
      restored = true;
    }
    // 开发期方便逐档检查立绘，生产构建不会读取这个参数。
    if (import.meta.env.DEV) {
      const fromUrl = Number(
        new URLSearchParams(location.search).get("confidence")
      );
      if (Number.isFinite(fromUrl)) {
        confidence = clampInteger(fromUrl, -100, 100);
      }
    }
    slider.value = String(confidence);
    const safeAmount =
      Number.isFinite(amount) && amount !== null
        ? Math.max(0, Math.trunc(amount))
        : config.betMin;
    amountInput.value = String(safeAmount);
    if (restored) {
      setTransientHint(t("detail.restored"), "info");
    }
  }

  function scheduleDraft(): void {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (!current) return;
      const confidence = clampInteger(Number(slider.value), -100, 100);
      if (!selectedOutcomeId) {
        ctx.setDraft(null);
        return;
      }
      const amount = Number(amountInput.value);
      ctx.setDraft({
        marketId: current.id,
        outcomeId: selectedOutcomeId,
        amount: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
        confidence,
        updatedAt: Date.now(),
      });
    }, 180);
  }

  function savePrefs(): void {
    const confidence = clampInteger(Number(slider.value), -100, 100);
    const amount = Number(amountInput.value);
    ctx.setPrefs({
      confidence,
      lastOutcomeId: selectedOutcomeId,
      amount: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
    });
  }

  async function submit(): Promise<void> {
    const market = current;
    if (!market) return;
    if (!ctx.isSignedIn()) {
      ctx.requestLogin();
      return;
    }
    const me = ctx.getMe();
    if (!me) {
      setTransientHint(t("detail.balanceUnknown"), "error");
      return;
    }
    const config = ctx.getConfig();
    const confidence = clampInteger(Number(slider.value), -100, 100);
    const outcomeId = selectedOutcomeId;
    if (!outcomeId) {
      setTransientHint("请选择一个结果", "error");
      return;
    }
    const check = validateAmount(
      amountInput.value,
      me.chips,
      config.betMin,
      config.maxBetRatio
    );
    if (!check.ok) {
      setTransientHint(amountMessage(check), "error");
      return;
    }
    if (market.status !== "open" || market.deadline <= ctx.serverNow()) {
      setTransientHint(t("errors.marketClosed"), "error");
      return;
    }

    const key = betIntentKey(market.id, outcomeId, check.amount, confidence);
    const clientRequestId = pendingBets.get(key) ?? createRequestId();
    pendingBets.set(key, clientRequestId);

    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = t("detail.submitting");
    submitButton.setAttribute("aria-busy", "true");
    clearTransientHint();

    try {
      const result = await ctx.api.placeBet({
        marketId: market.id,
        outcomeId,
        amount: check.amount,
        confidence,
        clientRequestId,
        displayName:
          ctx.connection.user?.name || ctx.connection.user?.username || undefined,
      });
      const updated = result.marketFull
        ? { ...result.marketFull, participants: market.participants }
        : applyOutcomePools(
            market,
            Object.fromEntries(
              result.market.outcomes.map((outcome) => [outcome.id, outcome.pool])
            )
          );
      ctx.upsertMarket(updated);
      ctx.setMe({ ...me, chips: result.chips });
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      ctx.setDraft(null);
      pendingBets.delete(key);
      const stillHere = currentId === market.id;
      if (stillHere) {
        setTransientHint(
          t("detail.success", { chips: formatChips(result.chips) }),
          "ok"
        );
      }
      ctx.toast(t("toast.betPlaced"), "success");
      if (stillHere) paintMarket(updated, false);
    } catch (error) {
      const message = describeError(error, {
        min: config.betMin,
        max: betLimit(me.chips, config.maxBetRatio),
      });
      const retryHint = shouldKeepRequestId(error)
        ? `（${t("detail.retryHint")}）`
        : "";
      if (currentId === market.id) {
        setTransientHint(`${message}${retryHint}`, "error");
      }
      ctx.toast(message, "error");
      const code = errorCode(error);
      if (
        code === "BET_TOO_LARGE" ||
        code === "CHIPS_TOO_LOW" ||
        code === "INSUFFICIENT_CHIPS"
      ) {
        void ctx.refreshMe();
      }
      if (!shouldKeepRequestId(error)) pendingBets.delete(key);
    } finally {
      submitting = false;
      submitButton.textContent = t("detail.submit");
      submitButton.removeAttribute("aria-busy");
      updateAll();
    }
  }

  async function open(id: string): Promise<void> {
    token += 1;
    const mine = token;
    currentId = id;
    deadlineHandled = false;
    clearTransientHint();
    const cached = ctx.getMarket(id);
    current = cached ?? null;
    if (cached) {
      paintMarket(cached, true);
    } else {
      show(body, false);
      show(errorEl, false);
      show(loadingEl, true);
    }

    try {
      const page = await ctx.api.markets({ id });
      if (token !== mine) return;
      const item = page.items[0] ?? null;
      if (!item) throw new ApiError("MARKET_NOT_FOUND");
      ctx.upsertMarket(item);
      paintMarket(item, !cached);
      ctx.banner(null);
    } catch (error) {
      if (token !== mine) return;
      if (current) {
        const cachedMarkets = ctx.cache.read<{ items: Market[] }>(
          CACHE_KEYS.markets
        );
        ctx.banner(
          t("common.offlineData", {
            time: formatDateTime(Date.now() - (cachedMarkets?.age ?? 0)),
          }),
          { tone: "offline", retry: () => void open(id) }
        );
      } else {
        show(body, false);
        show(loadingEl, false);
        show(errorEl, true);
        errorText.textContent = describeError(error);
      }
    } finally {
      if (token === mine) show(loadingEl, false);
    }
  }

  slider.addEventListener("input", () => {
    clearTransientHint();
    updateAll();
    scheduleDraft();
  });
  slider.addEventListener("change", () => {
    savePrefs();
  });

  amountInput.addEventListener("input", () => {
    clearTransientHint();
    updateAll();
    scheduleDraft();
  });
  amountInput.addEventListener("change", () => {
    savePrefs();
  });

  for (const button of quickButtons) {
    button.addEventListener("click", () => {
      const me = ctx.getMe();
      const config = ctx.getConfig();
      const kind = button.dataset.quick as "min" | "half" | "max";
      const value = quickAmount(
        kind,
        me?.chips ?? 0,
        config.betMin,
        config.maxBetRatio
      );
      amountInput.value = String(value);
      clearTransientHint();
      updateAll();
      savePrefs();
      scheduleDraft();
    });
  }

  submitButton.addEventListener("click", () => void submit());
  byId("detail-back").addEventListener("click", () => ctx.goTab("markets"));
  byId("detail-error-back").addEventListener("click", () =>
    ctx.goTab("markets")
  );
  byId("detail-retry").addEventListener("click", () => {
    if (currentId) void open(currentId);
  });

  return {
    open,
    refresh() {
      if (!current) return;
      paintConsensus(current);
      paintTimeline(current);
      paintGates(current);
      updateAll();
    },
    tick() {
      if (!current || deadlineHandled) return;
      if (current.status !== "open" || current.deadline > ctx.serverNow()) return;
      deadlineHandled = true;
      paintGates(current);
      updateAll();
    },
  };
}
