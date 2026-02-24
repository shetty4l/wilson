/**
 * CalendarChannel — reads Apple Calendar and posts raw event data to cortex.
 *
 * Behavior:
 * - Polls Apple Calendar via osascript/JXA at configurable intervals
 * - Diff-based: maintains hash of event snapshot, skips POST when unchanged
 * - Extended 30-day scan on first sync of each day, 14-day otherwise
 * - Errors are logged, not thrown (polling loop never crashes)
 */

import { createLogger } from "@shetty4l/core/log";
import type { StateLoader } from "@shetty4l/core/state";
import { createHash } from "crypto";
import { CalendarChannelState } from "../../state/calendar";
import type { CortexClient } from "../cortex-client";
import type { Channel, ChannelStats } from "../index";
import { readAppleCalendar, type SpawnFn } from "./apple-calendar";

const log = createLogger("wilson:calendar");

// --- Recovery types ---

export type RecoveryAction = "kill_osascript" | "restart_calendar";

export type RecoverFn = (action: RecoveryAction) => Promise<boolean>;

/**
 * Default recovery implementation using system commands.
 * Returns true if recovery command executed successfully.
 */
const defaultRecover: RecoverFn = async (action) => {
  try {
    if (action === "kill_osascript") {
      // Kill any hung osascript processes related to Calendar
      const proc = Bun.spawn(["pkill", "-9", "-f", "osascript.*Calendar"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      // pkill returns 0 if processes killed, 1 if none found - both are "success"
      return true;
    } else if (action === "restart_calendar") {
      // Quit Calendar.app gracefully then relaunch
      const quit = Bun.spawn(
        ["osascript", "-e", 'tell app "Calendar" to quit'],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await quit.exited;
      // Wait a moment for app to fully quit
      await new Promise((r) => setTimeout(r, 1000));
      // Relaunch Calendar.app
      const launch = Bun.spawn(["open", "-a", "Calendar"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await launch.exited;
      return exitCode === 0;
    }
    return false;
  } catch {
    return false;
  }
};

// --- Config ---

export interface CalendarChannelConfig {
  pollIntervalSeconds: number;
  lookAheadDays: number;
  extendedLookAheadDays: number;
  includeCalendars?: string[];
}

// --- Recovery constants ---

/** Number of consecutive timeouts before attempting recovery */
const RECOVERY_THRESHOLD = 3;

/** Minimum time between recovery attempts (5 minutes) */
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

// --- Channel ---

export class CalendarChannel implements Channel {
  name = "calendar";
  canReceive = true;
  canDeliver = false;
  mode = "buffered" as const;
  priority = 2;

  private running = false;
  private timer: Timer | null = null;
  private spawnFn: SpawnFn | undefined;
  private stateLoader: StateLoader | null;
  private state: CalendarChannelState | null = null;

  // In-memory fallback for tests without stateLoader
  private memoryState = {
    lastHash: null as string | null,
    lastExtendedSyncDate: null as string | null,
    lastSyncAt: null as Date | null,
    lastPostAt: null as Date | null,
    eventsPosted: 0,
    status: "healthy" as string,
    error: null as string | null,
    consecutiveFailures: 0,
    lastRecoveryAt: null as Date | null,
  };

  // Recovery function for dependency injection (testability)
  private recoverFn: RecoverFn;

  constructor(
    private cortex: CortexClient,
    private config: CalendarChannelConfig,
    stateLoaderOrSpawnFn?: StateLoader | SpawnFn,
    spawnFnOrRecover?: SpawnFn | RecoverFn,
    recoverFn?: RecoverFn,
  ) {
    // Support both old signature (cortex, config, spawnFn) and new (cortex, config, stateLoader, spawnFn, recoverFn)
    if (typeof stateLoaderOrSpawnFn === "function") {
      this.stateLoader = null;
      this.spawnFn = stateLoaderOrSpawnFn;
      this.recoverFn = defaultRecover;
    } else {
      this.stateLoader = stateLoaderOrSpawnFn ?? null;
      // spawnFnOrRecover could be SpawnFn or RecoverFn - detect by arity/name
      if (typeof spawnFnOrRecover === "function") {
        // If recoverFn is also provided, spawnFnOrRecover is SpawnFn
        if (recoverFn) {
          this.spawnFn = spawnFnOrRecover as SpawnFn;
          this.recoverFn = recoverFn;
        } else {
          // Only one function provided - assume it's SpawnFn for backwards compat
          this.spawnFn = spawnFnOrRecover as SpawnFn;
          this.recoverFn = defaultRecover;
        }
      } else {
        this.spawnFn = undefined;
        this.recoverFn = defaultRecover;
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    log("starting calendar channel");

    // Load persisted state if stateLoader available
    if (this.stateLoader) {
      this.state = this.stateLoader.load(CalendarChannelState, "calendar");
    }

    // Initial sync immediately
    await this.sync();

    // Recurring syncs
    this.timer = setInterval(
      () => void this.sync(),
      this.config.pollIntervalSeconds * 1000,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log("calendar channel stopped");
  }

  getStats(): ChannelStats {
    if (this.state) {
      return {
        lastSyncAt: this.state.lastSyncAt?.getTime() ?? null,
        lastPostAt: this.state.lastPostAt?.getTime() ?? null,
        eventsPosted: this.state.eventsPosted,
        status: this.state.status as ChannelStats["status"],
        error: this.state.error,
        consecutiveFailures: this.state.consecutiveFailures ?? 0,
        lastExtendedSyncDate: this.state.lastExtendedSyncDate
          ? new Date(this.state.lastExtendedSyncDate).getTime()
          : null,
      };
    }
    // Fallback to in-memory state for tests
    return {
      lastSyncAt: this.memoryState.lastSyncAt?.getTime() ?? null,
      lastPostAt: this.memoryState.lastPostAt?.getTime() ?? null,
      eventsPosted: this.memoryState.eventsPosted,
      status: this.memoryState.status as ChannelStats["status"],
      error: this.memoryState.error,
      consecutiveFailures: this.memoryState.consecutiveFailures,
      lastExtendedSyncDate: this.memoryState.lastExtendedSyncDate
        ? new Date(this.memoryState.lastExtendedSyncDate).getTime()
        : null,
    };
  }

  async sync(): Promise<void> {
    if (!this.running) return;

    const s = this.state ?? this.memoryState;

    try {
      // Determine look-ahead window
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      let windowDays: number;

      if (s.lastExtendedSyncDate !== today) {
        windowDays = this.config.extendedLookAheadDays;
        s.lastExtendedSyncDate = today;
      } else {
        windowDays = this.config.lookAheadDays;
      }

      // Read events
      const result = await readAppleCalendar({
        lookAheadDays: windowDays,
        includeCalendars: this.config.includeCalendars,
        spawn: this.spawnFn,
      });

      // Handle read errors
      if (!result.ok) {
        const error = result.error;
        s.consecutiveFailures++;
        if (error.type === "timeout") {
          log(
            `sync: osascript timed out (consecutive: ${s.consecutiveFailures})`,
          );
          s.status = "degraded";
          s.error = "Calendar read timed out";

          // Attempt recovery after hitting threshold
          if (s.consecutiveFailures >= RECOVERY_THRESHOLD) {
            await this.attemptRecovery(s);
          }
        } else if (error.type === "osascript_failed") {
          log(
            `sync: osascript failed (exit ${error.exitCode}): ${error.stderr}`,
          );
          s.status = "error";
          s.error = `osascript failed: ${error.stderr}`;
        } else if (error.type === "parse_error") {
          log(`sync: parse error: ${error.message}`);
          s.status = "error";
          s.error = `Parse error: ${error.message}`;
        } else {
          log(`sync: exception: ${error.message}`);
          s.status = "error";
          s.error = error.message;
        }
        s.lastSyncAt = new Date();
        return;
      }

      const events = result.value;

      // Update lastSyncAt - we successfully read from Apple Calendar
      s.lastSyncAt = new Date();
      s.status = "healthy";
      s.error = null;
      s.consecutiveFailures = 0;

      // Sort for stable hashing
      const sorted = [...events].sort(
        (a, b) =>
          a.startDate.localeCompare(b.startDate) || a.uid.localeCompare(b.uid),
      );

      // Diff detection
      const hash = createHash("sha256")
        .update(JSON.stringify(sorted))
        .digest("hex");

      if (hash === s.lastHash) {
        log(
          `sync: no changes (${sorted.length} events, ${windowDays}d window)`,
        );
        s.eventsPosted = 0;
        return;
      }

      s.lastHash = hash;

      // Post to cortex
      const postResult = await this.cortex.receive({
        channel: "calendar",
        externalId: `cal-sync-${Date.now()}`,
        data: { events: sorted, windowDays },
        occurredAt: new Date().toISOString(),
        mode: "buffered",
      });

      if (postResult.ok) {
        log(
          `sync: posted ${sorted.length} events (${windowDays}d window, status: ${postResult.value.status})`,
        );
        s.lastPostAt = new Date();
        s.eventsPosted = sorted.length;
      } else {
        log(`sync: cortex error: ${postResult.error}`);
        s.status = "degraded";
        s.error = `Cortex error: ${postResult.error}`;
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log(`sync error: ${errorMsg}`);
      s.status = "error";
      s.error = errorMsg;
    }
  }

  // --- Recovery ---

  /**
   * Attempt to recover from consecutive timeouts.
   *
   * Recovery is rate-limited to once per 5 minutes.
   * Step 1: Kill hung osascript processes
   * Step 2: If at double threshold (6 failures), also restart Calendar.app
   */
  private async attemptRecovery(
    s: CalendarChannelState | typeof this.memoryState,
  ): Promise<void> {
    const now = Date.now();
    const lastRecovery = s.lastRecoveryAt?.getTime() ?? 0;

    // Rate-limit recovery attempts
    if (now - lastRecovery < RECOVERY_COOLDOWN_MS) {
      log(
        `recovery: skipping (cooldown, last attempt ${Math.round((now - lastRecovery) / 1000)}s ago)`,
      );
      return;
    }

    s.lastRecoveryAt = new Date();

    // Step 1: Kill hung osascript processes
    log("recovery: killing hung osascript processes");
    await this.recoverFn("kill_osascript");

    // Step 2: If at double threshold, also restart Calendar.app
    if (s.consecutiveFailures >= RECOVERY_THRESHOLD * 2) {
      log("recovery: restarting Calendar.app");
      const restartSuccess = await this.recoverFn("restart_calendar");
      if (restartSuccess) {
        log("recovery: Calendar.app restarted, will retry on next sync");
      } else {
        log("recovery: Calendar.app restart failed");
      }
    } else {
      log("recovery: osascript processes killed, will retry on next sync");
    }
  }

  // --- Test helpers ---

  /** @internal — exposed for testing */
  _getLastHash(): string | null {
    return this.state?.lastHash ?? this.memoryState.lastHash;
  }

  /** @internal — exposed for testing */
  _getLastExtendedSyncDate(): string | null {
    return (
      this.state?.lastExtendedSyncDate ?? this.memoryState.lastExtendedSyncDate
    );
  }

  /** @internal — exposed for testing */
  _setLastExtendedSyncDate(date: string | null): void {
    if (this.state) {
      this.state.lastExtendedSyncDate = date;
    } else {
      this.memoryState.lastExtendedSyncDate = date;
    }
  }
}
