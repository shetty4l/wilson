/**
 * Read Apple Calendar events via osascript (JXA).
 *
 * macOS only. Returns Result with error type indicating failure reason.
 */

import { createLogger } from "@shetty4l/core/log";
import { err, ok, type Result } from "@shetty4l/core/result";

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

/** Error types for calendar read failures */
export type CalendarReadError =
  | { type: "timeout" }
  | { type: "osascript_failed"; exitCode: number; stderr: string }
  | { type: "parse_error"; message: string }
  | { type: "exception"; message: string };

export type ReadAppleCalendarResult = Result<
  CalendarEvent[],
  CalendarReadError
>;

// --- JXA script ---

function buildJxaScript(
  lookAheadDays: number,
  includeCalendars?: string[],
): string {
  // Build calendar filter logic if includeCalendars is provided
  const filterLogic =
    includeCalendars && includeCalendars.length > 0
      ? `
var includeList = ${JSON.stringify(includeCalendars.map((c) => c.toLowerCase()))};
function shouldInclude(calName) {
  return includeList.indexOf(calName.toLowerCase()) !== -1;
}
`
      : `
function shouldInclude(calName) { return true; }
`;

  return `
var Calendar = Application("Calendar");
var now = new Date();
var end = new Date(now.getTime() + ${lookAheadDays} * 86400000);
var results = [];
var calendars = Calendar.calendars();
${filterLogic}
for (var i = 0; i < calendars.length; i++) {
  var cal = calendars[i];
  if (!shouldInclude(cal.name())) continue;
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

const SPAWN_TIMEOUT_MS = 60_000; // 60 seconds

export type SpawnFn = (
  cmd: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = async (cmd) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutId: Timer | null = null;

  const outputPromise = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  })();

  const timeoutPromise = new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    timeoutId = setTimeout(() => {
      proc.kill(9); // SIGKILL for hard termination
      log("osascript timed out after 60s");
      resolve({ exitCode: -1, stdout: "", stderr: "osascript timed out" });
    }, SPAWN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([outputPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

// --- Public API ---

export interface ReadAppleCalendarOptions {
  lookAheadDays: number;
  includeCalendars?: string[];
  spawn?: SpawnFn;
}

/**
 * Read Apple Calendar events for the next N days.
 *
 * Uses osascript with JXA (JavaScript for Automation) to query Calendar.app.
 * Returns Result type — Ok with events or Err with typed error.
 *
 * @param options.lookAheadDays - Number of days to look ahead
 * @param options.includeCalendars - Optional list of calendar names to include (case-insensitive)
 * @param options.spawn - Optional spawn function for dependency injection
 */
export async function readAppleCalendar(
  options: ReadAppleCalendarOptions,
): Promise<ReadAppleCalendarResult> {
  const { lookAheadDays, includeCalendars, spawn = defaultSpawn } = options;
  try {
    const script = buildJxaScript(lookAheadDays, includeCalendars);
    const { exitCode, stdout, stderr } = await spawn([
      "osascript",
      "-l",
      "JavaScript",
      "-e",
      script,
    ]);

    if (exitCode !== 0) {
      const timedOut = stderr.includes("timed out");
      log(`osascript failed (exit ${exitCode}): ${stderr.trim()}`);
      if (timedOut) {
        return err({ type: "timeout" });
      }
      return err({ type: "osascript_failed", exitCode, stderr: stderr.trim() });
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return ok([]);
    }

    try {
      const events = JSON.parse(trimmed) as CalendarEvent[];
      if (!Array.isArray(events)) {
        log("osascript returned non-array result");
        return err({
          type: "parse_error",
          message: "osascript returned non-array result",
        });
      }
      return ok(events);
    } catch (parseErr) {
      const message =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      log(`failed to parse calendar JSON: ${message}`);
      return err({ type: "parse_error", message });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`failed to read Apple Calendar: ${message}`);
    return err({ type: "exception", message });
  }
}
