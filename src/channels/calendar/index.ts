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
import { createHash } from "crypto";
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
  private lastHash: string | null = null;
  private lastExtendedSyncDate: string | null = null; // "YYYY-MM-DD"
  private spawnFn: SpawnFn | undefined;

  // Stats tracking
  private stats: ChannelStats = {
    lastSyncAt: null,
    lastPostAt: null,
    eventsPosted: 0,
    status: "healthy",
    error: null,
  };

  constructor(
    private cortex: CortexClient,
    private config: CalendarChannelConfig,
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn = spawnFn;
  }

  async start(): Promise<void> {
    this.running = true;
    log("starting calendar channel");

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
    return { ...this.stats };
  }

  async sync(): Promise<void> {
    if (!this.running) return;

    try {
      // Determine look-ahead window
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      let windowDays: number;

      if (this.lastExtendedSyncDate !== today) {
        windowDays = this.config.extendedLookAheadDays;
        this.lastExtendedSyncDate = today;
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
      this.stats.lastSyncAt = Date.now();
      this.stats.status = "healthy";
      this.stats.error = null;

      // Sort for stable hashing
      const sorted = [...events].sort(
        (a, b) =>
          a.startDate.localeCompare(b.startDate) || a.uid.localeCompare(b.uid),
      );

      // Diff detection
      const hash = createHash("sha256")
        .update(JSON.stringify(sorted))
        .digest("hex");

      if (hash === this.lastHash) {
        log(
          `sync: no changes (${sorted.length} events, ${windowDays}d window)`,
        );
        this.stats.eventsPosted = 0;
        return;
      }

      this.lastHash = hash;

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
        this.stats.lastPostAt = Date.now();
        this.stats.eventsPosted = sorted.length;
      } else {
        log(`sync: cortex error: ${result.error}`);
        this.stats.status = "degraded";
        this.stats.error = `Cortex error: ${result.error}`;
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log(`sync error: ${errorMsg}`);
      this.stats.status = "error";
      this.stats.error = errorMsg;
    }
  }

  // --- Test helpers ---

  /** @internal — exposed for testing */
  _getLastHash(): string | null {
    return this.lastHash;
  }

  /** @internal — exposed for testing */
  _getLastExtendedSyncDate(): string | null {
    return this.lastExtendedSyncDate;
  }

  /** @internal — exposed for testing */
  _setLastExtendedSyncDate(date: string | null): void {
    this.lastExtendedSyncDate = date;
  }
}
