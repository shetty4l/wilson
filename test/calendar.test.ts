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

    // osascript failed → empty events → still posts initial (empty array hash differs from null)
    expect(cortex.calls.length).toBe(1);
    const data = cortex.calls[0].data as {
      events: CalendarEvent[];
      windowDays: number;
    };
    expect(data.events).toEqual([]);
  });
});
