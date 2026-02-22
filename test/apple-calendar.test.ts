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

    const result = await readAppleCalendar(14, spawn);
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

    const result = await readAppleCalendar(14, spawn);
    expect(result).toEqual([]);
  });

  test("returns empty array on empty calendar", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    const result = await readAppleCalendar(14, spawn);
    expect(result).toEqual([]);
  });

  test("returns empty array when spawn throws", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("spawn failed");
    };

    const result = await readAppleCalendar(14, spawn);
    expect(result).toEqual([]);
  });

  test("returns empty array on invalid JSON output", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "not valid json",
      stderr: "",
    });

    const result = await readAppleCalendar(14, spawn);
    expect(result).toEqual([]);
  });

  test("returns empty array when output is empty string", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const result = await readAppleCalendar(14, spawn);
    expect(result).toEqual([]);
  });
});
