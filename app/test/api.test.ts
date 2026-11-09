import { describe, expect, test } from "bun:test";
import {
  createApi,
  type Transport,
  type TransportRequest,
} from "../src/api.ts";
import { ApiError, describeError } from "../src/errors.ts";
import type { BetInput } from "../src/types.ts";

function fakeTransport(
  handler: (
    endpoint: string,
    request: TransportRequest
  ) => Promise<{ status: number; body: unknown }>
): { transport: Transport; calls: Array<{ endpoint: string; request: TransportRequest }> } {
  const calls: Array<{ endpoint: string; request: TransportRequest }> = [];
  const transport: Transport = async (endpoint, request) => {
    calls.push({ endpoint, request });
    return handler(endpoint, request);
  };
  return { transport, calls };
}

function ok(data: unknown, status = 200) {
  return { status, body: { ok: true, data } };
}

const betInput: BetInput = {
  marketId: "m1",
  side: "yes",
  amount: 100,
  confidence: 72,
  clientRequestId: "8f1c1a5e-3f3c-4a1e-9d7e-5e3a0c9b2a10",
};

describe("API envelope parsing", () => {
  test("reads and normalizes config", async () => {
    const { transport } = fakeTransport(async () =>
      ok({
        productName: "预言鲸",
        season: "2026-11",
        betMin: 10,
        maxBetRatio: 0.5,
        dailyChips: 100,
        initialChips: 1000,
        serverTime: 1760000000000,
      })
    );
    const api = createApi(transport);
    await expect(api.config()).resolves.toMatchObject({
      productName: "预言鲸",
      season: "2026-11",
      betMin: 10,
      serverTime: 1760000000000,
    });
  });

  test("normalizes market fields and keeps optional participants", async () => {
    const { transport } = fakeTransport(async () =>
      ok({
        items: [
          {
            id: "m1",
            title: "V5？",
            deadline: 1798732799000,
            status: "open",
            yesPool: 1200,
            noPool: 800,
            impliedYes: 0.6,
            payoutYes: 1.83,
            payoutNo: 2.75,
            participants: 88,
          },
        ],
        nextCursor: "m1",
      })
    );
    const api = createApi(transport);
    const page = await api.markets({ limit: 20 });
    expect(page.nextCursor).toBe("m1");
    expect(page.items[0]).toMatchObject({
      id: "m1",
      status: "open",
      yesPool: 1200,
      participants: 88,
    });
    expect(page.items[0].outcome).toBeNull();
  });

  test("maps API failures to ApiError codes", async () => {
    const { transport } = fakeTransport(async () => ({
      status: 400,
      body: {
        ok: false,
        error: { code: "BET_TOO_LARGE", message: "server copy" },
      },
    }));
    const api = createApi(transport);
    const error = await api.config().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("BET_TOO_LARGE");
    expect(describeError(error, { max: 500 })).toContain("500");
    expect(describeError(error, { max: 500 })).not.toContain("server copy");
  });

  test("handles HTTP failures without an envelope", async () => {
    const { transport } = fakeTransport(async () => ({
      status: 503,
      body: null,
    }));
    const api = createApi(transport);
    const error = await api.config().catch((cause: unknown) => cause);
    expect((error as ApiError).code).toBe("HTTP_ERROR");
  });

  test("maps bare auth and rate-limit statuses", async () => {
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [429, "RATE_LIMIT"],
    ] as const) {
      const api = createApi(async () => ({ status, body: null }));
      await expect(api.config()).rejects.toMatchObject({ code });
    }
  });

  test("rejects a successful status with unusable body", async () => {
    const { transport } = fakeTransport(async () => ({
      status: 200,
      body: "nope",
    }));
    const api = createApi(transport);
    const error = await api.config().catch((cause: unknown) => cause);
    expect((error as ApiError).code).toBe("BAD_RESPONSE");
  });

  test("maps transport failures", async () => {
    const offline = createApi(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(offline.config()).rejects.toMatchObject({ code: "OFFLINE" });

    const timeout = createApi(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(timeout.config()).rejects.toMatchObject({ code: "TIMEOUT" });

    const denied = createApi(async () => {
      throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
    });
    await expect(denied.config()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("API methods", () => {
  test("parses me, claim, leaderboard and rank", async () => {
    const { transport, calls } = fakeTransport(async (endpoint) => {
      if (endpoint === "me") {
        return ok({
          displayName: "鲸友",
          chips: 900,
          season: "2026-11",
          canClaim: true,
          nextClaimAt: null,
          stats: { staked: 10, payout: 20, correct: 1, total: 2, accuracy: 0.5 },
        });
      }
      if (endpoint === "claim") {
        return ok({ claimed: true, chips: 1000, amount: 100 });
      }
      if (endpoint === "publicLeaderboard") {
        return ok({
          season: "2026-11",
          type: "accuracy",
          items: [
            {
              rank: 1,
              displayName: "A",
              chips: 100,
              accuracy: 0.8,
              samples: 5,
            },
          ],
        });
      }
      return ok({ rank: null, samples: 0 });
    });
    const api = createApi(transport);
    await expect(api.me()).resolves.toMatchObject({
      chips: 900,
      canClaim: true,
    });
    await expect(api.claim("鲸友")).resolves.toEqual({
      claimed: true,
      chips: 1000,
      amount: 100,
    });
    expect(calls.find((call) => call.endpoint === "claim")?.request.json).toEqual({
      displayName: "鲸友",
    });
    const board = await api.leaderboard({
      type: "accuracy",
      season: "2026-11",
    });
    expect(board.items[0]).toMatchObject({ rank: 1, accuracy: 0.8 });
    await expect(
      api.myRank({ type: "assets", season: "2026-11" })
    ).resolves.toMatchObject({ rank: null, samples: 0 });
  });

  test("tolerates aggregated positions and history shapes", async () => {
    const { transport } = fakeTransport(async (endpoint) => {
      if (endpoint === "positions") {
        return ok({
          positions: [
            {
              market_id: "m1",
              marketTitle: "标题",
              side: "no",
              stake: 50,
              status: "open",
              return: 0,
              created_at: 1_700_000_000_000,
            },
          ],
          nextCursor: null,
        });
      }
      return ok({
        items: [
          {
            betId: "b1",
            marketId: "m1",
            side: "yes",
            amount: 80,
            status: "won",
            payout: 160,
            season: "2026-11",
          },
        ],
        nextCursor: "b1",
      });
    });
    const api = createApi(transport);
    const positions = await api.positions({ status: "open" });
    expect(positions.items[0]).toMatchObject({
      marketId: "m1",
      title: "标题",
      side: "no",
      amount: 50,
      payout: 0,
      createdAt: 1_700_000_000_000,
    });
    const history = await api.history({ season: "2026-11" });
    expect(history.items[0]).toMatchObject({
      id: "b1",
      marketId: "m1",
      status: "won",
      payout: 160,
    });
    expect(history.nextCursor).toBe("b1");
  });

  test("retries an offline bet with the same client request id", async () => {
    let attempts = 0;
    const { transport, calls } = fakeTransport(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return ok({
        betId: "b1",
        chips: 900,
        market: {
          id: "m1",
          title: "V5？",
          deadline: 1_800_000_000_000,
          status: "open",
          yesPool: 1300,
          noPool: 800,
          seedYes: 5000,
          seedNo: 5000,
          impliedYes: 0.62,
          payoutYes: 1.5,
          payoutNo: 2.5,
        },
      });
    });
    const api = createApi(transport, { retryDelayMs: 0 });
    const first = await api.placeBet(betInput);
    expect(first.chips).toBe(900);
    expect(first.marketFull).toMatchObject({ id: "m1", status: "open" });
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(2);
    const firstBody = calls[0].request.json as BetInput;
    const secondBody = calls[1].request.json as BetInput;
    expect(secondBody.clientRequestId).toBe(firstBody.clientRequestId);
    expect(secondBody).toEqual(firstBody);
  });

  test("does not retry a definitive server rejection", async () => {
    let calls = 0;
    const api = createApi(
      async () => {
        calls += 1;
        return {
          status: 400,
          body: {
            ok: false,
            error: { code: "BET_TOO_LARGE", message: "" },
          },
        };
      },
      { retryDelayMs: 0 }
    );
    await expect(api.placeBet(betInput)).rejects.toMatchObject({
      code: "BET_TOO_LARGE",
    });
    expect(calls).toBe(1);
  });
});

describe("error descriptions", () => {
  test("never echoes raw server text", () => {
    const error = new ApiError("BET_TOO_LARGE", "骰子 赔率 下注", 400);
    const message = describeError(error, { max: 120 });
    expect(message).toContain("120");
    expect(message).not.toContain("骰子");
    expect(message).not.toContain("赔率");
  });

  test("includes an unknown code for support", () => {
    const message = describeError(new ApiError("SOMETHING_NEW"));
    expect(message).toContain("SOMETHING_NEW");
  });

  test("falls back for non-API failures", () => {
    expect(describeError(new Error("boom"))).toContain("稍后");
  });
});
