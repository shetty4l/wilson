import { afterEach, describe, expect, test } from "bun:test";
import { ok, type Result } from "@shetty4l/core/result";
import type { CalendarEvent } from "../src/channels/calendar/apple-calendar";
import { CalendarChannel } from "../src/channels/calendar/index";
import type {
  CortexClient,
  ReceivePayload,
  ReceiveResponse,
} from "../src/channels/cortex-client";

// --- Mock CortexClient ---

function makeMockCortex() {
  const calls: ReceivePayload[] = [];
  const client = {
    calls,
    receive: async (
      payload: ReceivePayload,
    ): Promise<Result<ReceiveResponse>> => {
      calls.push(payload);
      return ok({ eventId: "evt-1", status: "queued" as const });
    },
    pollOutbox: async () => ok([] as never[]),
    ackOutbox: async () => ok(undefined),
  } as unknown as CortexClient & { calls: ReceivePayload[] };
  return client;
}

// --- Mock spawn for osascript ---

function makeSpawn(events: CalendarEvent[]) {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify(events),
    stderr: "",
  });
}

function makeFailingSpawn() {
  return async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "osascript: not available",
  });
}

const DEFAULT_CONFIG = {
  pollIntervalSeconds: 3600, // large so timer doesn't fire during tests
  lookAheadDays: 14,
  extendedLookAheadDays: 30,
};

const SAMPLE_EVENTS: CalendarEvent[] = [
  {
    uid: "evt-1",
    title: "Meeting",
    startDate: "2026-02-23T10:00:00.000Z",
    endDate: "2026-02-23T11:00:00.000Z",
    location: "Office",
    notes: "Weekly standup",
    calendarName: "Work",
  },
  {
    uid: "evt-2",
    title: "Lunch",
    startDate: "2026-02-23T12:00:00.000Z",
    endDate: "2026-02-23T13:00:00.000Z",
    location: "",
    notes: "",
    calendarName: "Home",
  },
];

describe("CalendarChannel", () => {
  let channel: CalendarChannel;

  afterEach(async () => {
    if (channel) await channel.stop();
  });

  test("start() triggers initial sync", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(SAMPLE_EVENTS),
    );

    await channel.start();

    // Initial sync should have posted events
    expect(cortex.calls.length).toBe(1);
    expect(cortex.calls[0].channel).toBe("calendar");
    const data = cortex.calls[0].data as {
      events: CalendarEvent[];
      windowDays: number;
    };
    expect(data.events.length).toBe(2);
  });

  test("stop() clears timer", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(SAMPLE_EVENTS),
    );

    await channel.start();
    await channel.stop();

    // After stop, sync() should be a no-op (running = false)
    const callsBefore = cortex.calls.length;
    await channel.sync();
    expect(cortex.calls.length).toBe(callsBefore);
  });

  test("sync() posts when events change", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(SAMPLE_EVENTS),
    );

    await channel.start();
    expect(cortex.calls.length).toBe(1);

    // Change events — different spawn
    const newEvents: CalendarEvent[] = [
      {
        ...SAMPLE_EVENTS[0],
        title: "Updated Meeting",
      },
    ];
    const channel2 = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(newEvents),
    );
    // Copy state
    Object.assign(channel2, {
      running: true,
      lastHash: channel._getLastHash(),
      lastExtendedSyncDate: channel._getLastExtendedSyncDate(),
    });

    await channel2.sync();
    expect(cortex.calls.length).toBe(2);
    await channel2.stop();
  });

  test("sync() skips when hash unchanged (diff detection)", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(SAMPLE_EVENTS),
    );

    await channel.start();
    expect(cortex.calls.length).toBe(1);

    // Sync again with same events — should skip
    await channel.sync();
    expect(cortex.calls.length).toBe(1); // no additional call
  });

  test("sync() uses extended window on first sync of day", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(
      cortex,
      DEFAULT_CONFIG,
      makeSpawn(SAMPLE_EVENTS),
    );

    // Ensure no previous extended sync
    channel._setLastExtendedSyncDate(null);

    await channel.start();
    expect(cortex.calls.length).toBe(1);

    const data = cortex.calls[0].data as {
      events: CalendarEvent[];
      windowDays: number;
    };
    // First sync of the day uses extended window
    expect(data.windowDays).toBe(30);
  });

  test("sync() uses normal window on subsequent syncs same day", async () => {
    const cortex = makeMockCortex();

    // We need different events for the second sync so it doesn't skip
    let callCount = 0;
    const spawn = async () => {
      callCount++;
      // Return different events each time to avoid hash match
      const events =
        callCount === 1
          ? SAMPLE_EVENTS
          : [
              {
                ...SAMPLE_EVENTS[0],
                uid: `evt-${callCount}`,
                title: `Event ${callCount}`,
              },
            ];
      return {
        exitCode: 0,
        stdout: JSON.stringify(events),
        stderr: "",
      };
    };

    channel = new CalendarChannel(cortex, DEFAULT_CONFIG, spawn);

    // Set extended sync to today so it uses normal window
    const today = new Date().toISOString().slice(0, 10);
    channel._setLastExtendedSyncDate(today);

    await channel.start();
    expect(cortex.calls.length).toBe(1);

    const data = cortex.calls[0].data as {
      events: CalendarEvent[];
      windowDays: number;
    };
    expect(data.windowDays).toBe(14); // normal window
  });

  test("sync() handles empty calendar gracefully", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(cortex, DEFAULT_CONFIG, makeSpawn([]));

    await channel.start();
    // Should still post (first sync, hash changes from null)
    expect(cortex.calls.length).toBe(1);
    const data = cortex.calls[0].data as {
      events: CalendarEvent[];
      windowDays: number;
    };
    expect(data.events).toEqual([]);
  });

  test("sync() handles osascript failure gracefully (doesn't crash)", async () => {
    const cortex = makeMockCortex();
    channel = new CalendarChannel(cortex, DEFAULT_CONFIG, makeFailingSpawn());

    // Should not throw
    await channel.start();

    // osascript failed → error state, no cortex post
    expect(cortex.calls.length).toBe(0);
    const stats = channel.getStats();
    expect(stats.status).toBe("error");
    expect(stats.error).toContain("osascript");
  });

  describe("stats tracking", () => {
    test("getStats() returns initial state before sync", () => {
      const cortex = makeMockCortex();
      channel = new CalendarChannel(
        cortex,
        DEFAULT_CONFIG,
        makeSpawn(SAMPLE_EVENTS),
      );

      const stats = channel.getStats();
      expect(stats.lastSyncAt).toBeNull();
      expect(stats.lastPostAt).toBeNull();
      expect(stats.eventsPosted).toBe(0);
      expect(stats.status).toBe("healthy");
      expect(stats.error).toBeNull();
    });

    test("getStats() updates after successful sync", async () => {
      const cortex = makeMockCortex();
      channel = new CalendarChannel(
        cortex,
        DEFAULT_CONFIG,
        makeSpawn(SAMPLE_EVENTS),
      );

      await channel.start();

      const stats = channel.getStats();
      expect(stats.lastSyncAt).toBeGreaterThan(0);
      expect(stats.lastPostAt).toBeGreaterThan(0);
      expect(stats.eventsPosted).toBe(2);
      expect(stats.status).toBe("healthy");
      expect(stats.error).toBeNull();
    });

    test("getStats() sets eventsPosted to 0 when hash unchanged", async () => {
      const cortex = makeMockCortex();
      channel = new CalendarChannel(
        cortex,
        DEFAULT_CONFIG,
        makeSpawn(SAMPLE_EVENTS),
      );

      await channel.start();
      const statsAfterFirst = channel.getStats();
      expect(statsAfterFirst.eventsPosted).toBe(2);

      // Sync again with same events (hash unchanged → skip post)
      await channel.sync();

      const statsAfterSecond = channel.getStats();
      expect(statsAfterSecond.eventsPosted).toBe(0);
      expect(statsAfterSecond.status).toBe("healthy");
    });

    test("getStats() sets error status on cortex failure", async () => {
      const calls: ReceivePayload[] = [];
      const failingCortex = {
        calls,
        receive: async (payload: ReceivePayload) => {
          calls.push(payload);
          return { ok: false, error: "Cortex unavailable" } as const;
        },
        pollOutbox: async () => ok([] as never[]),
        ackOutbox: async () => ok(undefined),
      } as unknown as CortexClient & { calls: ReceivePayload[] };

      channel = new CalendarChannel(
        failingCortex,
        DEFAULT_CONFIG,
        makeSpawn(SAMPLE_EVENTS),
      );

      await channel.start();

      const stats = channel.getStats();
      expect(stats.lastSyncAt).toBeGreaterThan(0); // Sync happened
      expect(stats.lastPostAt).toBeNull(); // Post failed
      expect(stats.status).toBe("degraded");
      expect(stats.error).toContain("Cortex");
    });

    test("getStats() shows error when osascript throws", async () => {
      const cortex = makeMockCortex();
      // Spawn that throws — readAppleCalendar catches it and returns Err
      const errorSpawn = async () => {
        throw new Error("spawn failed");
      };

      channel = new CalendarChannel(cortex, DEFAULT_CONFIG, errorSpawn);

      await channel.start();

      // readAppleCalendar catches the error and returns Err — sync records error state
      const stats = channel.getStats();
      expect(stats.status).toBe("error");
      expect(stats.error).toContain("spawn failed");
      expect(stats.lastSyncAt).toBeGreaterThan(0);
      expect(stats.eventsPosted).toBe(0);
    });

    test("getStats() returns a copy (immutable)", async () => {
      const cortex = makeMockCortex();
      channel = new CalendarChannel(
        cortex,
        DEFAULT_CONFIG,
        makeSpawn(SAMPLE_EVENTS),
      );

      await channel.start();

      const stats1 = channel.getStats();
      const stats2 = channel.getStats();
      expect(stats1).not.toBe(stats2); // Different objects
      expect(stats1).toEqual(stats2); // Same values
    });
  });

  describe("includeCalendars filtering", () => {
    test("passes includeCalendars to readAppleCalendar", async () => {
      const cortex = makeMockCortex();
      let capturedOptions: {
        lookAheadDays: number;
        includeCalendars?: string[];
      } | null = null;

      // Custom spawn that captures the script to verify filtering
      const spawn = async (cmd: string[]) => {
        // Parse the options from the script if needed, but simpler to check the script content
        const script = cmd[4];
        if (script.includes('["work","home"]')) {
          capturedOptions = {
            lookAheadDays: 30,
            includeCalendars: ["work", "home"],
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(SAMPLE_EVENTS),
          stderr: "",
        };
      };

      const configWithFilter = {
        ...DEFAULT_CONFIG,
        includeCalendars: ["Work", "Home"],
      };

      channel = new CalendarChannel(cortex, configWithFilter, spawn);
      await channel.start();

      // The script should contain the filter
      expect(capturedOptions).not.toBeNull();
    });

    test("syncs without filter when includeCalendars is undefined", async () => {
      const cortex = makeMockCortex();
      let scriptContainsNoFilter = false;

      const spawn = async (cmd: string[]) => {
        const script = cmd[4];
        // When no filter, shouldInclude always returns true
        if (script.includes("shouldInclude(calName) { return true; }")) {
          scriptContainsNoFilter = true;
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(SAMPLE_EVENTS),
          stderr: "",
        };
      };

      channel = new CalendarChannel(cortex, DEFAULT_CONFIG, spawn);
      await channel.start();

      expect(scriptContainsNoFilter).toBe(true);
    });
  });
});
