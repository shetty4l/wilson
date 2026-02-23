import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { StateLoader } from "@shetty4l/core/state";
import { CalendarChannelState } from "../../src/state/calendar";

describe("CalendarChannelState", () => {
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  test("initializes with defaults", () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    const state = loader.load(CalendarChannelState, "calendar");

    expect(state.lastSyncAt).toBe(null);
    expect(state.lastPostAt).toBe(null);
    expect(state.eventsPosted).toBe(0);
    expect(state.status).toBe("healthy");
    expect(state.error).toBe(null);
    expect(state.lastHash).toBe(null);
    expect(state.lastExtendedSyncDate).toBe(null);
  });

  test("persists and restores lastHash", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // First load - set values
    const state1 = loader.load(CalendarChannelState, "calendar");
    state1.lastHash = "abc123def456";
    await loader.flush();

    // Second load - verify restored
    const loader2 = new StateLoader(db);
    const state2 = loader2.load(CalendarChannelState, "calendar");
    expect(state2.lastHash).toBe("abc123def456");
  });

  test("persists and restores lastExtendedSyncDate", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // First load - set values
    const state1 = loader.load(CalendarChannelState, "calendar");
    state1.lastExtendedSyncDate = "2026-02-23";
    await loader.flush();

    // Second load - verify restored
    const loader2 = new StateLoader(db);
    const state2 = loader2.load(CalendarChannelState, "calendar");
    expect(state2.lastExtendedSyncDate).toBe("2026-02-23");
  });

  test("persists and restores stats fields", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // First load - set values
    const state1 = loader.load(CalendarChannelState, "calendar");
    state1.lastSyncAt = new Date("2026-02-23T10:00:00Z");
    state1.lastPostAt = new Date("2026-02-23T10:00:01Z");
    state1.eventsPosted = 42;
    state1.status = "degraded";
    state1.error = "Cortex timeout";
    await loader.flush();

    // Second load - verify restored
    const loader2 = new StateLoader(db);
    const state2 = loader2.load(CalendarChannelState, "calendar");
    expect(state2.lastSyncAt?.toISOString()).toBe("2026-02-23T10:00:00.000Z");
    expect(state2.lastPostAt?.toISOString()).toBe("2026-02-23T10:00:01.000Z");
    expect(state2.eventsPosted).toBe(42);
    expect(state2.status).toBe("degraded");
    expect(state2.error).toBe("Cortex timeout");
  });

  test("survives simulated restart", async () => {
    db = new Database(":memory:");

    // Session 1: Initialize and set state
    {
      const loader = new StateLoader(db);
      const state = loader.load(CalendarChannelState, "calendar");
      state.lastHash = "hash-before-restart";
      state.lastExtendedSyncDate = "2026-02-22";
      state.eventsPosted = 10;
      state.lastSyncAt = new Date("2026-02-22T08:00:00Z");
      await loader.flush();
    }

    // Session 2: Simulate restart - new StateLoader, same db
    {
      const loader = new StateLoader(db);
      const state = loader.load(CalendarChannelState, "calendar");

      // Verify state survived
      expect(state.lastHash).toBe("hash-before-restart");
      expect(state.lastExtendedSyncDate).toBe("2026-02-22");
      expect(state.eventsPosted).toBe(10);
      expect(state.lastSyncAt?.toISOString()).toBe("2026-02-22T08:00:00.000Z");

      // Update state in new session
      state.lastHash = "hash-after-restart";
      state.eventsPosted = 15;
      await loader.flush();
    }

    // Session 3: Verify updates persisted
    {
      const loader = new StateLoader(db);
      const state = loader.load(CalendarChannelState, "calendar");
      expect(state.lastHash).toBe("hash-after-restart");
      expect(state.eventsPosted).toBe(15);
    }
  });

  test("handles null values correctly", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // Set non-null values
    const state1 = loader.load(CalendarChannelState, "calendar");
    state1.lastHash = "some-hash";
    state1.error = "some error";
    await loader.flush();

    // Set back to null
    const loader2 = new StateLoader(db);
    const state2 = loader2.load(CalendarChannelState, "calendar");
    state2.lastHash = null;
    state2.error = null;
    await loader2.flush();

    // Verify null persisted
    const loader3 = new StateLoader(db);
    const state3 = loader3.load(CalendarChannelState, "calendar");
    expect(state3.lastHash).toBe(null);
    expect(state3.error).toBe(null);
  });

  test("supports multiple instances with different keys", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // Load two instances with different keys
    const calendar1 = loader.load(CalendarChannelState, "calendar-work");
    const calendar2 = loader.load(CalendarChannelState, "calendar-personal");

    calendar1.lastHash = "work-hash";
    calendar1.eventsPosted = 5;

    calendar2.lastHash = "personal-hash";
    calendar2.eventsPosted = 10;

    await loader.flush();

    // Verify they're independent
    const loader2 = new StateLoader(db);
    const restored1 = loader2.load(CalendarChannelState, "calendar-work");
    const restored2 = loader2.load(CalendarChannelState, "calendar-personal");

    expect(restored1.lastHash).toBe("work-hash");
    expect(restored1.eventsPosted).toBe(5);

    expect(restored2.lastHash).toBe("personal-hash");
    expect(restored2.eventsPosted).toBe(10);
  });
});
