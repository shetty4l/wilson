import { describe, expect, test } from "bun:test";
import { ok } from "@shetty4l/core/result";

// --- Mock helpers ---

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

/** Override Bun.spawn with a mock that captures calls. */
function mockSpawn(
  handler: (cmd: string[], opts: unknown) => ReturnType<typeof spawnOk>,
): () => void {
  const original = Bun.spawn;
  // @ts-expect-error — overriding Bun.spawn for testing
  Bun.spawn = handler;
  return () => {
    Bun.spawn = original;
  };
}

/** Override globalThis.fetch to mock health endpoints. */
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
    return handler(url, init);
  };
  Object.assign(mock, { preconnect: original.preconnect });
  globalThis.fetch = mock as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ─── ensureServicesRunning ──────────────────────────────────────

describe("ensureServicesRunning", () => {
  test("starts services that are not healthy", async () => {
    const startedServices: string[] = [];

    // All services unhealthy
    const restoreFetch = mockFetch(() => {
      throw new TypeError("Unable to connect");
    });

    const restoreSpawn = mockSpawn((cmd) => {
      startedServices.push(cmd[0]);
      return spawnOk();
    });

    try {
      const { ensureServicesRunning } = await import("../src/supervise");
      await ensureServicesRunning();

      // Should have attempted to start all 4 services
      expect(startedServices.length).toBe(4);

      // Should be in dependency order: engram → synapse → cortex → wilson
      expect(startedServices[0]).toContain("engram");
      expect(startedServices[1]).toContain("synapse");
      expect(startedServices[2]).toContain("cortex");
      expect(startedServices[3]).toContain("wilson");
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("skips services that are already healthy", async () => {
    const startedServices: string[] = [];

    const restoreFetch = mockFetch(() => {
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn((cmd) => {
      startedServices.push(cmd[0]);
      return spawnOk();
    });

    try {
      const { ensureServicesRunning } = await import("../src/supervise");
      await ensureServicesRunning();

      // No services should have been started
      expect(startedServices.length).toBe(0);
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("handles start failure gracefully", async () => {
    const restoreFetch = mockFetch(() => {
      throw new TypeError("Unable to connect");
    });

    const restoreSpawn = mockSpawn(() => spawnFail(1, "already running"));

    try {
      const { ensureServicesRunning } = await import("../src/supervise");
      // Should not throw
      await ensureServicesRunning();
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });
});

// ─── runHealthCheck ─────────────────────────────────────────────

describe("runHealthCheck", () => {
  test("restarts unhealthy services", async () => {
    const restartedServices: string[] = [];

    // Make engram unhealthy, others healthy
    const restoreFetch = mockFetch((url) => {
      if (url.includes("7749")) {
        throw new TypeError("Unable to connect");
      }
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn((cmd) => {
      restartedServices.push(cmd[0]);
      return spawnOk();
    });

    try {
      const { runHealthCheck } = await import("../src/supervise");
      await runHealthCheck();

      // Only engram should have been restarted (restartService calls spawn once if it succeeds)
      expect(restartedServices.length).toBe(1);
      expect(restartedServices[0]).toContain("engram");
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("does not restart healthy services", async () => {
    const restartedServices: string[] = [];

    const restoreFetch = mockFetch(() => {
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn((cmd) => {
      restartedServices.push(cmd[0]);
      return spawnOk();
    });

    try {
      const { runHealthCheck } = await import("../src/supervise");
      await runHealthCheck();

      expect(restartedServices.length).toBe(0);
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });
});

// ─── runUpdateCheck (round-robin) ───────────────────────────────

describe("runUpdateCheck", () => {
  test("cycles through services round-robin", async () => {
    const checkedServices: string[] = [];

    // All services up-to-date (same version)
    const restoreFetch = mockFetch((url) => {
      if (url.includes("api.github.com")) {
        // Extract repo name from URL for logging
        return new Response(JSON.stringify({ tag_name: "v0.2.0" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn(() => spawnOk());

    try {
      const { runUpdateCheck, resetUpdateIndex } = await import(
        "../src/supervise"
      );
      resetUpdateIndex();

      // Run 5 checks — should cycle through all 4 services and wrap around
      for (let i = 0; i < 5; i++) {
        const result = await runUpdateCheck(null);
        checkedServices.push(result.service);
      }

      // Should cycle: engram, synapse, cortex, wilson, engram
      expect(checkedServices[0]).toBe("engram");
      expect(checkedServices[1]).toBe("synapse");
      expect(checkedServices[2]).toBe("cortex");
      expect(checkedServices[3]).toBe("wilson");
      expect(checkedServices[4]).toBe("engram"); // wraps around
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("returns selfUpdateInstalled: true when wilson is updated", async () => {
    // Mock: wilson has older version, latest is newer
    const restoreFetch = mockFetch((url) => {
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn(() => spawnOk());

    try {
      const { runUpdateCheck, resetUpdateIndex } = await import(
        "../src/supervise"
      );

      // Set index to 3 (wilson) so next check is wilson
      resetUpdateIndex();
      // Skip to wilson (index 3)
      await runUpdateCheck(null); // engram
      await runUpdateCheck(null); // synapse
      await runUpdateCheck(null); // cortex

      // Now wilson
      const result = await runUpdateCheck(null);
      expect(result.service).toBe("wilson");
      expect(result.selfUpdateInstalled).toBe(true);
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });

  test("returns selfUpdateInstalled: false for non-wilson updates", async () => {
    const restoreFetch = mockFetch((url) => {
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
      });
    });

    const restoreSpawn = mockSpawn(() => spawnOk());

    try {
      const { runUpdateCheck, resetUpdateIndex } = await import(
        "../src/supervise"
      );
      resetUpdateIndex();

      // Check engram (index 0)
      const result = await runUpdateCheck("token");
      expect(result.service).toBe("engram");
      expect(result.selfUpdateInstalled).toBe(false);
    } finally {
      restoreFetch();
      restoreSpawn();
    }
  });
});

// ─── stopAllServices ────────────────────────────────────────────

describe("stopAllServices", () => {
  test("stops services in reverse order", async () => {
    const stoppedServices: string[] = [];

    const restoreSpawn = mockSpawn((cmd) => {
      stoppedServices.push(cmd[0]);
      return spawnOk();
    });

    try {
      const { stopAllServices } = await import("../src/supervise");
      await stopAllServices();

      // Should stop in reverse order: wilson → cortex → synapse → engram
      expect(stoppedServices.length).toBe(4);
      expect(stoppedServices[0]).toContain("wilson");
      expect(stoppedServices[1]).toContain("cortex");
      expect(stoppedServices[2]).toContain("synapse");
      expect(stoppedServices[3]).toContain("engram");
    } finally {
      restoreSpawn();
    }
  });

  test("calls stop command for each service", async () => {
    const calls: Array<{ cmd: string[] }> = [];

    const restoreSpawn = mockSpawn((cmd) => {
      calls.push({ cmd });
      return spawnOk();
    });

    try {
      const { stopAllServices } = await import("../src/supervise");
      await stopAllServices();

      // Each call should be [cliPath, "stop"]
      for (const call of calls) {
        expect(call.cmd[1]).toBe("stop");
      }
    } finally {
      restoreSpawn();
    }
  });

  test("handles stop failure gracefully", async () => {
    const restoreSpawn = mockSpawn(() => spawnFail(1, "not running"));

    try {
      const { stopAllServices } = await import("../src/supervise");
      // Should not throw
      await stopAllServices();
    } finally {
      restoreSpawn();
    }
  });
});

// ─── Calendar buffered mode ─────────────────────────────────────

describe("calendar buffered mode", () => {
  test("CalendarChannel.sync() includes mode: 'buffered' in payload", async () => {
    const { CalendarChannel } = await import("../src/channels/calendar/index");

    const calls: Array<Record<string, unknown>> = [];
    const mockCortex = {
      receive: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return ok({ eventId: "evt-1", status: "queued" as const });
      },
      pollOutbox: async () => ok([] as never[]),
      ackOutbox: async () => ok(undefined),
    };

    const events = [
      {
        uid: "evt-1",
        title: "Test",
        startDate: "2026-02-23T10:00:00.000Z",
        endDate: "2026-02-23T11:00:00.000Z",
        location: "",
        notes: "",
        calendarName: "Work",
      },
    ];

    const spawn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(events),
      stderr: "",
    });

    const channel = new CalendarChannel(
      mockCortex as never,
      {
        pollIntervalSeconds: 3600,
        lookAheadDays: 14,
        extendedLookAheadDays: 30,
      },
      spawn,
    );

    await channel.start();

    expect(calls.length).toBe(1);
    expect(calls[0].mode).toBe("buffered");

    await channel.stop();
  });
});
