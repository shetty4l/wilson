/**
 * Read Apple Calendar events via osascript (JXA).
 *
 * macOS only. Returns empty array on failure (non-macOS, no Calendar access, etc.).
 */

import { createLogger } from "@shetty4l/core/log";

const log = createLogger("wilson:calendar");

// --- Types ---

export interface CalendarEvent {
  uid: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  notes: string;
  calendarName: string;
}

// --- JXA script ---

function buildJxaScript(lookAheadDays: number): string {
  return `
var Calendar = Application("Calendar");
var now = new Date();
var end = new Date(now.getTime() + ${lookAheadDays} * 86400000);
var results = [];
var calendars = Calendar.calendars();
for (var i = 0; i < calendars.length; i++) {
  var cal = calendars[i];
  var events = cal.events.whose({
    _and: [
      { startDate: { _greaterThan: now } },
      { startDate: { _lessThan: end } }
    ]
  })();
  for (var j = 0; j < events.length; j++) {
    var evt = events[j];
    results.push({
      uid: evt.uid(),
      title: evt.summary(),
      startDate: evt.startDate().toISOString(),
      endDate: evt.endDate().toISOString(),
      location: evt.location() || "",
      notes: evt.description() || "",
      calendarName: cal.name()
    });
  }
}
JSON.stringify(results);
`.trim();
}

// --- Spawn type for dependency injection ---

export type SpawnFn = (
  cmd: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = async (cmd) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

// --- Public API ---

/**
 * Read Apple Calendar events for the next N days.
 *
 * Uses osascript with JXA (JavaScript for Automation) to query Calendar.app.
 * Returns empty array on any failure — never throws.
 */
export async function readAppleCalendar(
  lookAheadDays: number,
  spawn: SpawnFn = defaultSpawn,
): Promise<CalendarEvent[]> {
  try {
    const script = buildJxaScript(lookAheadDays);
    const { exitCode, stdout, stderr } = await spawn([
      "osascript",
      "-l",
      "JavaScript",
      "-e",
      script,
    ]);

    if (exitCode !== 0) {
      log(`osascript failed (exit ${exitCode}): ${stderr.trim()}`);
      return [];
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const events = JSON.parse(trimmed) as CalendarEvent[];
    if (!Array.isArray(events)) {
      log("osascript returned non-array result");
      return [];
    }

    return events;
  } catch (e) {
    log(
      `failed to read Apple Calendar: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}
