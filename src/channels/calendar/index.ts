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
import type { Channel } from "../index";
import { readAppleCalendar, type SpawnFn } from "./apple-calendar";

const log = createLogger("wilson:calendar");

// --- Config ---

export interface CalendarChannelConfig {
  pollIntervalSeconds: number;
  lookAheadDays: number;
  extendedLookAheadDays: number;
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
      const events = await readAppleCalendar(windowDays, this.spawnFn);

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
        return;
      }

      this.lastHash = hash;

      // Post to cortex
      const result = await this.cortex.receive({
        channel: "calendar",
        externalId: `cal-sync-${Date.now()}`,
        data: { events: sorted, windowDays },
        occurredAt: new Date().toISOString(),
      });

      if (result.ok) {
        log(
          `sync: posted ${sorted.length} events (${windowDays}d window, status: ${result.value.status})`,
        );
      } else {
        log(`sync: cortex error: ${result.error}`);
      }
    } catch (e) {
      log(`sync error: ${e instanceof Error ? e.message : String(e)}`);
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
