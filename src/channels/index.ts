/**
 * Channel abstraction for Wilson's organism architecture.
 *
 * Channels are independent input/output pathways (calendar, email, web, etc.)
 * that connect Wilson to the outside world. Each channel runs its own
 * polling/listening loop and communicates with cortex via the CortexClient.
 */

import { createLogger } from "@shetty4l/core/log";

const log = createLogger("wilson:channels");

// --- Channel interface ---

export interface Channel {
  /** Unique channel name (e.g. "calendar", "email"). */
  name: string;
  /** Whether this channel can receive external input and send it to cortex. */
  canReceive: boolean;
  /** Whether this channel can deliver cortex output to external destinations. */
  canDeliver: boolean;
  /** "realtime" for push-based channels, "buffered" for polling-based. */
  mode: "realtime" | "buffered";
  /** Priority level (0 = highest). Used by thalamus for routing decisions. */
  priority: number;
  /** Start the channel's polling/listening loop. */
  start(): Promise<void>;
  /** Stop the channel gracefully. */
  stop(): Promise<void>;
  /** Trigger an immediate sync cycle (on-demand). */
  sync(): Promise<void>;
}

// --- Channel registry ---

/**
 * Registry for managing channel lifecycle.
 *
 * Channels are started sequentially in registration order and
 * stopped in reverse order for clean shutdown.
 */
export class ChannelRegistry {
  private readonly channels: Channel[] = [];
  private readonly byName = new Map<string, Channel>();

  /** Register a channel. Throws if a channel with the same name exists. */
  register(channel: Channel): void {
    if (this.byName.has(channel.name)) {
      throw new Error(`channel "${channel.name}" is already registered`);
    }
    this.channels.push(channel);
    this.byName.set(channel.name, channel);
  }

  /** Get a channel by name. */
  get(name: string): Channel | undefined {
    return this.byName.get(name);
  }

  /** Get all registered channels in registration order. */
  getAll(): Channel[] {
    return [...this.channels];
  }

  /** Start all channels sequentially in registration order. */
  async startAll(): Promise<void> {
    for (const ch of this.channels) {
      log(`starting channel: ${ch.name}`);
      await ch.start();
      log(`channel started: ${ch.name}`);
    }
  }

  /** Stop all channels in reverse registration order. */
  async stopAll(): Promise<void> {
    const reversed = [...this.channels].reverse();
    for (const ch of reversed) {
      log(`stopping channel: ${ch.name}`);
      try {
        await ch.stop();
        log(`channel stopped: ${ch.name}`);
      } catch (e) {
        log(`channel stop error (${ch.name}): ${e}`);
      }
    }
  }
}
