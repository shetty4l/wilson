import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServiceConfig } from "../src/services";

/**
 * Test helpers
 */

const TMP = join(tmpdir(), `wilson-update-test-${process.pid}`);

function makeSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "engram",
    displayName: "Engram",
    repo: "shetty4l/engram",
    port: 7749,
    healthUrl: "http://localhost:7749/health",
    installBase: join(TMP, "srv", "engram"),
    configDir: join(TMP, ".config", "engram"),
    currentVersionFile: join(TMP, "srv", "engram", "current-version"),
    cliPath: "/usr/bin/true",
    logFiles: { daemon: join(TMP, "engram.log") },
    ...overrides,
  };
}

/** Override globalThis.fetch with a GitHub API interceptor, preserving types. */
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  const mock = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("api.github.com")) {
      return handler(url, init);
    }
    return original(input, init);
  };
  // Preserve preconnect to satisfy Bun's fetch type
  Object.assign(mock, { preconnect: original.preconnect });
  globalThis.fetch = mock as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Override Bun.spawn with a mock that captures calls. */
function mockSpawn(
  handler: (
    cmd: string[],
    opts: unknown,
  ) => {
    exited: Promise<number>;
    stdout: ReadableStream;
    stderr: ReadableStream;
    kill: () => void;
  },
): () => void {
  const original = Bun.spawn;
  // @ts-expect-error — overriding Bun.spawn for testing
  Bun.spawn = handler;
  return () => {
    Bun.spawn = original;
  };
}

function makeReadableStream(content = ""): ReadableStream {
  return new ReadableStream({
    start(controller) {
      if (content) {
        controller.enqueue(new TextEncoder().encode(content));
      }
      controller.close();
    },
  });
}

function spawnOk() {
  return {
    exited: Promise.resolve(0),
    stdout: makeReadableStream(),
    stderr: makeReadableStream(),
    kill: () => {},
  };
}

function spawnFail(code: number, stderr = "") {
  return {
    exited: Promise.resolve(code),
    stdout: makeReadableStream(),
    stderr: makeReadableStream(stderr),
    kill: () => {},
  };
}

// ─── readGithubToken ────────────────────────────────────────────

describe("readGithubToken", () => {
  test("returns null or string (contract test)", async () => {
    // readGithubToken reads a hardcoded path (~/.config/wilson/github-token).
    // We verify the contract: it returns null or a non-empty string.
    const { readGithubToken } = await import("../src/update");
    const result = readGithubToken();
    expect(result === null || typeof result === "string").toBe(true);
    if (result !== null) {
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

// ─── readCurrentVersion ─────────────────────────────────────────

describe("readCurrentVersion", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "srv", "engram"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  test("returns version when file exists", async () => {
    const { readCurrentVersion } = await import("../src/update");
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "0.2.1\n");
    expect(readCurrentVersion(svc)).toBe("0.2.1");
  });

  test("returns null when file does not exist", async () => {
    const { readCurrentVersion } = await import("../src/update");
    const svc = makeSvc({
      currentVersionFile: join(TMP, "nonexistent", "current-version"),
    });
    expect(readCurrentVersion(svc)).toBeNull();
  });

  test("trims whitespace from version", async () => {
    const { readCurrentVersion } = await import("../src/update");
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "  0.3.0  \n");
    expect(readCurrentVersion(svc)).toBe("0.3.0");
  });

  test("returns null for empty file", async () => {
    const { readCurrentVersion } = await import("../src/update");
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "");
    expect(readCurrentVersion(svc)).toBeNull();
  });
});

// ─── fetchLatestVersion ─────────────────────────────────────────

describe("fetchLatestVersion", () => {
  test("returns version with v prefix stripped", async () => {
    const restore = mockFetch(
      () =>
        new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 }),
    );
    try {
      const { fetchLatestVersion } = await import("../src/update");
      const result = await fetchLatestVersion(makeSvc(), null);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBe("0.3.0");
    } finally {
      restore();
    }
  });

  test("returns version without v prefix unchanged", async () => {
    const restore = mockFetch(
      () =>
        new Response(JSON.stringify({ tag_name: "0.3.0" }), { status: 200 }),
    );
    try {
      const { fetchLatestVersion } = await import("../src/update");
      const result = await fetchLatestVersion(makeSvc(), null);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBe("0.3.0");
    } finally {
      restore();
    }
  });

  test("includes Authorization header when token provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = mockFetch((_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      capturedHeaders = h ?? {};
      return new Response(JSON.stringify({ tag_name: "v0.3.0" }), {
        status: 200,
      });
    });
    try {
      const { fetchLatestVersion } = await import("../src/update");
      await fetchLatestVersion(makeSvc(), "ghp_test123");
      expect(capturedHeaders.Authorization).toBe("Bearer ghp_test123");
    } finally {
      restore();
    }
  });

  test("omits Authorization header when token is null", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = mockFetch((_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      capturedHeaders = h ?? {};
      return new Response(JSON.stringify({ tag_name: "v0.3.0" }), {
        status: 200,
      });
    });
    try {
      const { fetchLatestVersion } = await import("../src/update");
      await fetchLatestVersion(makeSvc(), null);
      expect(capturedHeaders.Authorization).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("returns err on non-200 response", async () => {
    const restore = mockFetch(
      () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
        }),
    );
    try {
      const { fetchLatestVersion } = await import("../src/update");
      const result = await fetchLatestVersion(makeSvc(), null);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error).toContain("403");
    } finally {
      restore();
    }
  });

  test("returns err when tag_name is missing", async () => {
    const restore = mockFetch(
      () => new Response(JSON.stringify({ id: 123 }), { status: 200 }),
    );
    try {
      const { fetchLatestVersion } = await import("../src/update");
      const result = await fetchLatestVersion(makeSvc(), null);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error).toContain("no tag_name");
    } finally {
      restore();
    }
  });

  test("returns err on network error", async () => {
    const restore = mockFetch(() => {
      throw new TypeError("Unable to connect");
    });
    try {
      const { fetchLatestVersion } = await import("../src/update");
      const result = await fetchLatestVersion(makeSvc(), null);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error).toContain("failed to fetch");
    } finally {
      restore();
    }
  });
});

// ─── installUpdate ──────────────────────────────────────────────

describe("installUpdate", () => {
  test("passes correct command and GITHUB_TOKEN in env", async () => {
    let capturedCmd: string[] = [];
    let capturedEnv: Record<string, string> | undefined;

    const restore = mockSpawn((cmd, opts) => {
      capturedCmd = cmd;
      capturedEnv = (opts as { env?: Record<string, string> })?.env;
      return spawnOk();
    });

    try {
      const { installUpdate } = await import("../src/update");
      const result = await installUpdate(makeSvc(), "ghp_test123");

      expect(result.ok).toBe(true);
      expect(capturedCmd[0]).toBe("bash");
      expect(capturedCmd[1]).toBe("-c");
      expect(capturedCmd[2]).toContain("install.sh");
      expect(capturedEnv?.GITHUB_TOKEN).toBe("ghp_test123");
      expect(capturedEnv?.SKIP_LAUNCHAGENT_RELOAD).toBe("1");
    } finally {
      restore();
    }
  });

  test("omits GITHUB_TOKEN when token is null", async () => {
    let capturedEnv: Record<string, string> | undefined;

    const restore = mockSpawn((_cmd, opts) => {
      capturedEnv = (opts as { env?: Record<string, string> })?.env;
      return spawnOk();
    });

    try {
      const { installUpdate } = await import("../src/update");
      await installUpdate(makeSvc(), null);
      expect(capturedEnv?.GITHUB_TOKEN).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("returns err on non-zero exit code", async () => {
    const restore = mockSpawn(() => spawnFail(1, "install failed"));

    try {
      const { installUpdate } = await import("../src/update");
      const result = await installUpdate(makeSvc(), null);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error).toContain("install failed");
    } finally {
      restore();
    }
  });
});

// ─── restartService ─────────────────────────────────────────────

describe("restartService", () => {
  test("returns ok on successful restart", async () => {
    let capturedCmd: string[] = [];
    const restore = mockSpawn((cmd) => {
      capturedCmd = cmd;
      return spawnOk();
    });

    try {
      const { restartService } = await import("../src/update");
      const result = await restartService(makeSvc());
      expect(result.ok).toBe(true);
      expect(capturedCmd).toEqual(["/usr/bin/true", "restart"]);
    } finally {
      restore();
    }
  });

  test("retries once on first failure then succeeds", async () => {
    let callCount = 0;
    const restore = mockSpawn(() => {
      callCount++;
      return callCount === 1 ? spawnFail(1) : spawnOk();
    });

    try {
      const { restartService } = await import("../src/update");
      const result = await restartService(makeSvc());
      expect(result.ok).toBe(true);
      expect(callCount).toBe(2);
    } finally {
      restore();
    }
  });

  test("returns err after two failures", async () => {
    const restore = mockSpawn(() => spawnFail(1, "not running"));

    try {
      const { restartService } = await import("../src/update");
      const result = await restartService(makeSvc());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error).toContain("restart failed");
    } finally {
      restore();
    }
  });
});

// ─── checkAndUpdate ─────────────────────────────────────────────

describe("checkAndUpdate", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "srv", "engram"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  test("returns updated: false when versions match", async () => {
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "0.3.0\n");

    const restoreFetch = mockFetch(
      () =>
        new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 }),
    );

    try {
      const { checkAndUpdate } = await import("../src/update");
      const logs: string[] = [];
      const result = await checkAndUpdate(svc, null, (m) => logs.push(m));

      expect(result.updated).toBe(false);
      expect(result.error).toBeUndefined();
      expect(logs.some((l) => l.includes("up to date"))).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  test("returns updated: true with from/to on success", async () => {
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "0.2.0\n");

    const restoreFetch = mockFetch(
      () =>
        new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 }),
    );
    const restoreSpawn = mockSpawn(() => spawnOk());

    try {
      const { checkAndUpdate } = await import("../src/update");
      const logs: string[] = [];
      const result = await checkAndUpdate(svc, "token", (m) => logs.push(m));

      expect(result.updated).toBe(true);
      expect(result.from).toBe("0.2.0");
      expect(result.to).toBe("0.3.0");
      expect(result.error).toBeUndefined();
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("returns error on fetch failure", async () => {
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "0.2.0\n");

    const restoreFetch = mockFetch(
      () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    );

    try {
      const { checkAndUpdate } = await import("../src/update");
      const logs: string[] = [];
      const result = await checkAndUpdate(svc, null, (m) => logs.push(m));

      expect(result.updated).toBe(false);
      expect(result.error).toContain("404");
    } finally {
      restoreFetch();
    }
  });

  test("returns error on install failure", async () => {
    const svc = makeSvc();
    writeFileSync(svc.currentVersionFile, "0.2.0\n");

    const restoreFetch = mockFetch(
      () =>
        new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 }),
    );
    const restoreSpawn = mockSpawn(() => spawnFail(1, "curl failed"));

    try {
      const { checkAndUpdate } = await import("../src/update");
      const logs: string[] = [];
      const result = await checkAndUpdate(svc, null, (m) => logs.push(m));

      expect(result.updated).toBe(false);
      expect(result.error).toContain("install failed");
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });
});

// ─── cmdUpdate ──────────────────────────────────────────────────

describe("cmdUpdate", () => {
  test("returns 1 for unknown service", async () => {
    const { cmdUpdate } = await import("../src/update");
    const originalError = console.error;
    const output: string[] = [];
    console.error = (msg: string) => output.push(msg);

    try {
      const code = await cmdUpdate(["nonexistent"], false);
      expect(code).toBe(1);
      expect(output.some((o) => o.includes("unknown service"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("returns 1 for unknown service in json mode", async () => {
    const { cmdUpdate } = await import("../src/update");
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (msg: string) => output.push(msg);

    try {
      const code = await cmdUpdate(["nonexistent"], true);
      expect(code).toBe(1);
      const parsed = JSON.parse(output[0]);
      expect(parsed.service).toBe("nonexistent");
      expect(parsed.error).toBeDefined();
    } finally {
      console.log = originalLog;
    }
  });
});
