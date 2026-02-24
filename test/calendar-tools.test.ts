import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../src/channels/calendar/apple-calendar";
import {
  CalendarChannel,
  type CalendarChannelConfig,
} from "../src/channels/calendar/index";
import type { CortexClient } from "../src/channels/cortex-client";

// --- Test Helpers ---

function makeMockCortex(): CortexClient {
  return {
    receive: async () => ({ ok: true, value: { status: "accepted" } }),
    deliver: async () => ({ ok: true, value: { status: "delivered" } }),
  } as unknown as CortexClient;
}

const defaultConfig: CalendarChannelConfig = {
  pollIntervalSeconds: 60,
  lookAheadDays: 14,
  extendedLookAheadDays: 30,
};

// --- Tool Definition Tests ---

describe("CalendarChannel tools", () => {
  test("exposes 4 tools", () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);
    expect(channel.tools).toHaveLength(4);
  });

  test("get_events tool has correct definition", () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);
    const tool = channel.tools.find((t) => t.name === "get_events");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Get calendar events for a date range");
    expect(tool!.mutatesState).toBe(false);
    expect(tool!.parameters).toEqual({
      type: "object",
      properties: {
        lookAheadDays: {
          type: "number",
          description: "Number of days to look ahead from now",
        },
      },
      required: ["lookAheadDays"],
    });
  });

  test("get_event tool has correct definition", () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);
    const tool = channel.tools.find((t) => t.name === "get_event");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Get a single calendar event by UID");
    expect(tool!.mutatesState).toBe(false);
    expect(tool!.parameters).toEqual({
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "The unique identifier of the event",
        },
      },
      required: ["uid"],
    });
  });

  test("create_event tool has correct definition", () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);
    const tool = channel.tools.find((t) => t.name === "create_event");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Create a new calendar event");
    expect(tool!.mutatesState).toBe(true);
    expect(tool!.parameters).toEqual({
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The title/summary of the event",
        },
        startDate: {
          type: "string",
          description: "Start date/time in ISO 8601 format",
        },
        endDate: {
          type: "string",
          description: "End date/time in ISO 8601 format",
        },
        calendarName: {
          type: "string",
          description: "Name of the calendar to create the event in (optional)",
        },
        location: {
          type: "string",
          description: "Location of the event (optional)",
        },
        notes: {
          type: "string",
          description: "Notes/description for the event (optional)",
        },
      },
      required: ["title", "startDate", "endDate"],
    });
  });

  test("delete_event tool has correct definition", () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);
    const tool = channel.tools.find((t) => t.name === "delete_event");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("Delete a calendar event by UID");
    expect(tool!.mutatesState).toBe(true);
    expect(tool!.parameters).toEqual({
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "The unique identifier of the event to delete",
        },
      },
      required: ["uid"],
    });
  });
});

// --- get_events Tool Tests ---

describe("get_events tool", () => {
  test("returns events for valid lookAheadDays", async () => {
    const events = [
      {
        uid: "uid-1",
        title: "Meeting",
        startDate: "2026-02-25T10:00:00.000Z",
        endDate: "2026-02-25T11:00:00.000Z",
        location: "",
        notes: "",
        calendarName: "Work",
      },
    ];
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(events),
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_events", {
      lookAheadDays: 7,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ events });
  });

  test("returns error for missing lookAheadDays", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("get_events", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("lookAheadDays must be a positive number");
  });

  test("returns error for invalid lookAheadDays", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("get_events", {
      lookAheadDays: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("lookAheadDays must be a positive number");
  });

  test("returns error on osascript timeout", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "osascript timed out",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_events", {
      lookAheadDays: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Calendar operation timed out");
  });

  test("returns error on osascript failure", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Calendar not running",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_events", {
      lookAheadDays: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Calendar operation failed: Calendar not running",
    );
  });
});

// --- get_event Tool Tests ---

describe("get_event tool", () => {
  test("returns event for valid uid", async () => {
    const event = {
      uid: "uid-123",
      title: "Meeting",
      startDate: "2026-02-25T10:00:00.000Z",
      endDate: "2026-02-25T11:00:00.000Z",
      location: "Room 1",
      notes: "Bring laptop",
      calendarName: "Work",
    };
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(event),
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_event", { uid: "uid-123" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(event);
  });

  test("returns error when event not found", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: "null",
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_event", {
      uid: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Event not found: nonexistent");
  });

  test("returns error for missing uid", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("get_event", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("uid is required");
  });

  test("returns error for empty uid", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("get_event", { uid: "" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("uid is required");
  });

  test("returns error on osascript timeout", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "osascript timed out",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("get_event", { uid: "uid-123" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Calendar operation timed out");
  });
});

// --- create_event Tool Tests ---

describe("create_event tool", () => {
  test("creates event and returns uid", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ uid: "new-uid-456" }),
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("create_event", {
      title: "New Meeting",
      startDate: "2026-02-26T14:00:00.000Z",
      endDate: "2026-02-26T15:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ uid: "new-uid-456" });
  });

  test("creates event with optional fields", async () => {
    let capturedScript = "";
    const spawn: SpawnFn = async (cmd) => {
      capturedScript = cmd[4];
      return {
        exitCode: 0,
        stdout: JSON.stringify({ uid: "new-uid-789" }),
        stderr: "",
      };
    };
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("create_event", {
      title: "Team Lunch",
      startDate: "2026-02-27T12:00:00.000Z",
      endDate: "2026-02-27T13:00:00.000Z",
      calendarName: "Work",
      location: "Cafe",
      notes: "Order pizza",
    });

    expect(result.success).toBe(true);
    expect(capturedScript).toContain('"Team Lunch"');
    expect(capturedScript).toContain('"Cafe"');
    expect(capturedScript).toContain('"Order pizza"');
  });

  test("returns error for missing title", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("create_event", {
      startDate: "2026-02-26T14:00:00.000Z",
      endDate: "2026-02-26T15:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("title, startDate, and endDate are required");
  });

  test("returns error for missing startDate", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("create_event", {
      title: "Meeting",
      endDate: "2026-02-26T15:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("title, startDate, and endDate are required");
  });

  test("returns error for missing endDate", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("create_event", {
      title: "Meeting",
      startDate: "2026-02-26T14:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("title, startDate, and endDate are required");
  });

  test("returns error on osascript failure", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Calendar not found: Nonexistent",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("create_event", {
      title: "Meeting",
      startDate: "2026-02-26T14:00:00.000Z",
      endDate: "2026-02-26T15:00:00.000Z",
      calendarName: "Nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Calendar operation failed");
  });
});

// --- delete_event Tool Tests ---

describe("delete_event tool", () => {
  test("deletes event successfully", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ deleted: true }),
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("delete_event", {
      uid: "uid-123",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ deleted: true });
  });

  test("returns error when event not found", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ deleted: false }),
      stderr: "",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("delete_event", {
      uid: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Event not found: nonexistent");
  });

  test("returns error for missing uid", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("delete_event", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("uid is required");
  });

  test("returns error for empty uid", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("delete_event", { uid: "" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("uid is required");
  });

  test("returns error on osascript timeout", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "osascript timed out",
    });
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig, spawn);

    const result = await channel.executeTool("delete_event", {
      uid: "uid-123",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Calendar operation timed out");
  });
});

// --- Unknown Tool Tests ---

describe("unknown tool", () => {
  test("returns error for unknown tool name", async () => {
    const channel = new CalendarChannel(makeMockCortex(), defaultConfig);

    const result = await channel.executeTool("unknown_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown tool: unknown_tool");
  });
});
