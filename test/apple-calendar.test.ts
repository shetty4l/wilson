import { describe, expect, test } from "bun:test";
import {
  type CalendarEvent,
  readAppleCalendar,
  type SpawnFn,
} from "../src/channels/calendar/apple-calendar";

describe("readAppleCalendar", () => {
  test("returns parsed events from osascript output", async () => {
    const events: CalendarEvent[] = [
      {
        uid: "uid-1",
        title: "Team Meeting",
        startDate: "2026-02-23T10:00:00.000Z",
        endDate: "2026-02-23T11:00:00.000Z",
        location: "Room 4",
        notes: "Bring slides",
        calendarName: "Work",
      },
      {
        uid: "uid-2",
        title: "Dentist",
        startDate: "2026-02-24T09:00:00.000Z",
        endDate: "2026-02-24T10:00:00.000Z",
        location: "123 Main St",
        notes: "",
        calendarName: "Home",
      },
    ];

    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(events),
      stderr: "",
    });

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual(events);
    expect(result.length).toBe(2);
    expect(result[0].title).toBe("Team Meeting");
    expect(result[1].calendarName).toBe("Home");
  });

  test("returns empty array on osascript failure", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "osascript: not available on this platform",
    });

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual([]);
  });

  test("returns empty array on empty calendar", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual([]);
  });

  test("returns empty array when spawn throws", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("spawn failed");
    };

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual([]);
  });

  test("returns empty array on invalid JSON output", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "not valid json",
      stderr: "",
    });

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual([]);
  });

  test("returns empty array when output is empty string", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
    expect(result).toEqual([]);
  });

  describe("timeout handling", () => {
    test("returns empty array on timeout (graceful fallback)", async () => {
      // Simulate a spawn that never resolves (would time out in real usage)
      // We test by returning the timeout result directly
      const spawn: SpawnFn = async () => ({
        exitCode: -1,
        stdout: "",
        stderr: "osascript timed out",
      });

      const result = await readAppleCalendar({ lookAheadDays: 14, spawn });
      expect(result).toEqual([]);
    });
  });

  describe("calendar filtering", () => {
    test("passes includeCalendars to JXA script", async () => {
      let capturedScript = "";
      const spawn: SpawnFn = async (cmd) => {
        // Capture the script argument
        capturedScript = cmd[4]; // osascript -l JavaScript -e <script>
        return { exitCode: 0, stdout: "[]", stderr: "" };
      };

      await readAppleCalendar({
        lookAheadDays: 14,
        includeCalendars: ["Work", "Home"],
        spawn,
      });

      // Verify the script contains the filter logic with lowercase names
      expect(capturedScript).toContain('["work","home"]');
      expect(capturedScript).toContain("shouldInclude");
    });

    test("queries all calendars when includeCalendars is empty", async () => {
      let capturedScript = "";
      const spawn: SpawnFn = async (cmd) => {
        capturedScript = cmd[4];
        return { exitCode: 0, stdout: "[]", stderr: "" };
      };

      await readAppleCalendar({
        lookAheadDays: 14,
        includeCalendars: [],
        spawn,
      });

      // With empty array, shouldInclude should always return true
      expect(capturedScript).toContain(
        "shouldInclude(calName) { return true; }",
      );
    });

    test("queries all calendars when includeCalendars is undefined", async () => {
      let capturedScript = "";
      const spawn: SpawnFn = async (cmd) => {
        capturedScript = cmd[4];
        return { exitCode: 0, stdout: "[]", stderr: "" };
      };

      await readAppleCalendar({
        lookAheadDays: 14,
        spawn,
      });

      // Without includeCalendars, shouldInclude should always return true
      expect(capturedScript).toContain(
        "shouldInclude(calName) { return true; }",
      );
    });

    test("case-insensitive matching in filter", async () => {
      let capturedScript = "";
      const spawn: SpawnFn = async (cmd) => {
        capturedScript = cmd[4];
        return { exitCode: 0, stdout: "[]", stderr: "" };
      };

      await readAppleCalendar({
        lookAheadDays: 14,
        includeCalendars: ["WORK", "Home", "Personal"],
        spawn,
      });

      // All names should be lowercased in the include list
      expect(capturedScript).toContain('["work","home","personal"]');
      // The comparison should also use toLowerCase
      expect(capturedScript).toContain("calName.toLowerCase()");
    });
  });
});
