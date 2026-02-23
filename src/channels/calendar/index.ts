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

// --- Config ---

export interface CalendarChannelConfig {
  pollIntervalSeconds: number;
  lookAheadDays: number;
  extendedLookAheadDays: number;
  includeCalendars?: string[];
}

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
  };

  constructor(
    private cortex: CortexClient,
    private config: CalendarChannelConfig,
    stateLoaderOrSpawnFn?: StateLoader | SpawnFn,
    spawnFn?: SpawnFn,
  ) {
    // Support both old signature (cortex, config, spawnFn) and new (cortex, config, stateLoader, spawnFn)
    if (typeof stateLoaderOrSpawnFn === "function") {
      this.stateLoader = null;
      this.spawnFn = stateLoaderOrSpawnFn;
    } else {
      this.stateLoader = stateLoaderOrSpawnFn ?? null;
      this.spawnFn = spawnFn;
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
      };
    }
    // Fallback to in-memory state for tests
    return {
      lastSyncAt: this.memoryState.lastSyncAt?.getTime() ?? null,
      lastPostAt: this.memoryState.lastPostAt?.getTime() ?? null,
      eventsPosted: this.memoryState.eventsPosted,
      status: this.memoryState.status as ChannelStats["status"],
      error: this.memoryState.error,
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
      const events = await readAppleCalendar({
        lookAheadDays: windowDays,
        includeCalendars: this.config.includeCalendars,
        spawn: this.spawnFn,
      });

      // Update lastSyncAt - we successfully read from Apple Calendar
      s.lastSyncAt = new Date();
      s.status = "healthy";
      s.error = null;

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
      const result = await this.cortex.receive({
        channel: "calendar",
        externalId: `cal-sync-${Date.now()}`,
        data: { events: sorted, windowDays },
        occurredAt: new Date().toISOString(),
        mode: "buffered",
      });

      if (result.ok) {
        log(
          `sync: posted ${sorted.length} events (${windowDays}d window, status: ${result.value.status})`,
        );
        s.lastPostAt = new Date();
        s.eventsPosted = sorted.length;
      } else {
        log(`sync: cortex error: ${result.error}`);
        s.status = "degraded";
        s.error = `Cortex error: ${result.error}`;
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log(`sync error: ${errorMsg}`);
      s.status = "error";
      s.error = errorMsg;
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
