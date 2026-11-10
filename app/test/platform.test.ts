import { describe, expect, test } from "bun:test";
import {
  loadPlatformUser,
  readLaunchParameters,
  writeClipboard,
  type PlatformConnection,
} from "../src/platform.ts";
import type { MiniAppSDK, MiniAppUser } from "@discourse-mini-app/sdk";

type PermissionsLike = {
  list(): string[];
  has(permission: string): boolean;
};

function fakeSDK(overrides: {
  permissions?: string[];
  launchParameters?: Record<string, string[]>;
  launchError?: Error;
  user?: MiniAppUser | null;
  userError?: Error;
  clipboardError?: Error;
} = {}): MiniAppSDK {
  const granted = overrides.permissions ?? [];
  const permissions: PermissionsLike = {
    list: () => granted,
    has: (permission: string) => granted.includes(permission),
  };
  return {
    permissions,
    launch: {
      getParameters: async () => {
        if (overrides.launchError) throw overrides.launchError;
        return { query: overrides.launchParameters ?? {}, hash: "" };
      },
    },
    user: {
      getCurrent: async () => {
        if (overrides.userError) throw overrides.userError;
        return overrides.user ?? null;
      },
      getById: async () => {
        throw new Error("not implemented");
      },
    },
    clipboard: {
      readText: async () => "",
      writeText: async (text: string) => {
        if (overrides.clipboardError) throw overrides.clipboardError;
        return null;
      },
    },
  } as unknown as MiniAppSDK;
}

function connection(sdk: MiniAppSDK | null): PlatformConnection {
  return { sdk, mode: sdk ? "guest" : "preview", user: null, theme: null };
}

function connectionWith(
  granted: string[],
  sdkOverrides: Parameters<typeof fakeSDK>[0] = {}
): PlatformConnection {
  const sdk = fakeSDK({ permissions: granted, ...sdkOverrides });
  return { sdk, mode: "guest", user: null, theme: null };
}

describe("readLaunchParameters", () => {
  test("有 sdk 与 launch.read 时返回 query", async () => {
    const connection = connectionWith(["launch.read"], {
      launchParameters: { card: ["1"], market: ["m_1"] },
    });
    expect(await readLaunchParameters(connection)).toEqual({
      card: ["1"],
      market: ["m_1"],
    });
  });

  test("缺 launch.read 权限时返回 null", async () => {
    const connection = connectionWith([], { launchParameters: { card: ["1"] } });
    expect(await readLaunchParameters(connection)).toBe(null);
  });

  test("无 sdk（本地预览）时返回 null", async () => {
    expect(await readLaunchParameters(connection(null))).toBe(null);
  });

  test("getParameters 抛错时返回 null 不冒泡", async () => {
    const connection = connectionWith(["launch.read"], {
      launchError: new Error("boom"),
    });
    expect(await readLaunchParameters(connection)).toBe(null);
  });
});

describe("loadPlatformUser", () => {
  const user: MiniAppUser = {
    id: 42,
    username: "whale",
    name: "鲸鱼",
    initials: "鲸",
    trustLevel: 2,
    avatarUrl: null,
  };

  test("有 user.read 且返回用户时 mode 变 connected", async () => {
    const original = connectionWith(["user.read"], { user });
    const next = await loadPlatformUser(original);
    expect(next.user).toEqual(user);
    expect(next.mode).toBe("connected");
    expect(next).not.toBe(original);
  });

  test("匿名会话 getCurrent 返回 null 时保持 guest", async () => {
    const original = connectionWith(["user.read"], { user: null });
    const next = await loadPlatformUser(original);
    expect(next.user).toBe(null);
    expect(next.mode).toBe("guest");
  });

  test("缺 user.read 时直接保持 guest，不调用 SDK", async () => {
    const original = connectionWith([], { user });
    const next = await loadPlatformUser(original);
    expect(next.user).toBe(null);
    expect(next.mode).toBe("guest");
  });

  test("getCurrent 抛错时回落 guest，不冒泡", async () => {
    const original = connectionWith(["user.read"], {
      userError: new Error("boom"),
    });
    const next = await loadPlatformUser(original);
    expect(next.mode).toBe("guest");
    expect(next.user).toBe(null);
  });

  test("无 sdk 时保持原样并返回新对象（本地预览）", async () => {
    const original = connection(null);
    const next = await loadPlatformUser(original);
    expect(next.mode).toBe("preview");
    expect(next.user).toBe(null);
    expect(next).not.toBe(original);
  });

  test("无 sdk 但已带用户的 demo 连接保持原样", async () => {
    const original: PlatformConnection = {
      sdk: null,
      mode: "connected",
      user,
      theme: null,
    };
    const next = await loadPlatformUser(original);
    expect(next.mode).toBe("connected");
    expect(next.user).toEqual(user);
  });

  test("ready 失败的 error 连接保持 error，不再读用户", async () => {
    const original = connectionWith(["user.read"], { user });
    const errored: PlatformConnection = { ...original, mode: "error" };
    const next = await loadPlatformUser(errored);
    expect(next.mode).toBe("error");
    expect(next.user).toBe(null);
  });
});

describe("writeClipboard", () => {
  function stubNavigatorClipboard(
    impl: { writeText(text: string): Promise<void> } | undefined
  ): void {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: impl,
      configurable: true,
    });
  }

  test("优先用 sdk.clipboard.writeText", async () => {
    let sdkCall: string | null = null;
    const connection: PlatformConnection = {
      sdk: {
        permissions: {
          list: () => ["clipboard.write"],
          has: (permission: string) => permission === "clipboard.write",
        },
        clipboard: {
          readText: async () => "",
          writeText: async (text: string) => {
            sdkCall = text;
            return null;
          },
        },
      } as unknown as MiniAppSDK,
      mode: "guest",
      user: null,
      theme: null,
    };
    stubNavigatorClipboard({
      writeText: async () => {
        throw new Error("navigator should not be used");
      },
    });
    try {
      await writeClipboard(connection, "hello");
    } finally {
      stubNavigatorClipboard(undefined);
    }
    expect(sdkCall as string | null).toBe("hello");
  });

  test("无 sdk 权限时回落 navigator.clipboard", async () => {
    const connection: PlatformConnection = {
      sdk: {
        permissions: {
          list: () => [],
          has: () => false,
        },
        clipboard: {
          readText: async () => "",
          writeText: async () => {
            throw new Error("sdk should not be used");
          },
        },
      } as unknown as MiniAppSDK,
      mode: "guest",
      user: null,
      theme: null,
    };
    let navigatorCall: string | null = null;
    stubNavigatorClipboard({
      writeText: async (text: string) => {
        navigatorCall = text;
      },
    });
    try {
      await writeClipboard(connection, "fallback");
    } finally {
      stubNavigatorClipboard(undefined);
    }
    expect(navigatorCall as string | null).toBe("fallback");
  });

  test("navigator.clipboard 不存在时也走通 sdk 路径", async () => {
    let sdkCall: string | null = null;
    const connection: PlatformConnection = {
      sdk: {
        permissions: {
          list: () => ["clipboard.write"],
          has: (permission: string) => permission === "clipboard.write",
        },
        clipboard: {
          readText: async () => "",
          writeText: async (text: string) => {
            sdkCall = text;
            return null;
          },
        },
      } as unknown as MiniAppSDK,
      mode: "guest",
      user: null,
      theme: null,
    };
    stubNavigatorClipboard(undefined);
    try {
      await writeClipboard(connection, "only-sdk");
    } finally {
      stubNavigatorClipboard(undefined);
    }
    expect(sdkCall as string | null).toBe("only-sdk");
  });

  test("sdk 与 navigator 都失败时抛错", async () => {
    const connection: PlatformConnection = {
      sdk: null,
      mode: "preview",
      user: null,
      theme: null,
    };
    stubNavigatorClipboard({
      writeText: async () => {
        throw new Error("no clipboard");
      },
    });
    try {
      await writeClipboard(connection, "x").then(
        () => expect.unreachable(),
        () => undefined
      );
    } finally {
      stubNavigatorClipboard(undefined);
    }
  });
});
