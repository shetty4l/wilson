/**
 * Channel abstraction for Wilson's organism architecture.
 *
 * Channels are independent input/output pathways (calendar, email, web, etc.)
 * that connect Wilson to the outside world. Each channel runs its own
 * polling/listening loop and communicates with cortex via the CortexClient.
 */

import { createLogger } from "@shetty4l/core/log";
import { err, ok, type Result } from "@shetty4l/core/result";

const log = createLogger("wilson:channels");

// --- Channel tools ---

/**
 * Describes a tool that a channel exposes for external invocation.
 */
export interface ChannelTool {
  /** Unique tool name within the channel. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema for the tool's parameters (optional). */
  parameters?: Record<string, unknown>;
}

/**
 * Result of executing a channel tool.
 */
export interface ToolResult {
  /** Whether the tool executed successfully. */
  success: boolean;
  /** Result data on success, or error details on failure. */
  data?: unknown;
  /** Error message if success is false. */
  error?: string;
}

// --- Channel stats ---

export interface ChannelStats {
  /** When the channel last synced with its external source. */
  lastSyncAt: number | null;
  /** When the channel last posted data to Cortex. */
  lastPostAt: number | null;
  /** Number of items posted in the last sync. */
  eventsPosted: number;
  /** Current channel health status. */
  status: "healthy" | "degraded" | "error";
  /** Last error message if status is error/degraded. */
  error: string | null;
  /** Number of consecutive failures (timeouts or errors). Resets on success. */
  consecutiveFailures: number;
  /** When the last extended sync (30-day window) occurred (calendar channel only). */
  lastExtendedSyncDate?: number | null;
}

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
  /** Get current channel stats. */
  getStats(): ChannelStats;
  /** Tools exposed by this channel (optional). */
  tools?: ChannelTool[];
  /** Execute a tool by name (optional - only if tools is defined). */
  executeTool?(
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<ToolResult>;
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

  /** Get stats for all channels. */
  getAllStats(): Record<string, ChannelStats> {
    const stats: Record<string, ChannelStats> = {};
    for (const ch of this.channels) {
      stats[ch.name] = ch.getStats();
    }
    return stats;
  }

  /** Get all tools from all channels, qualified by channel name. */
  getAllTools(): Array<{ channel: string; tool: ChannelTool }> {
    const result: Array<{ channel: string; tool: ChannelTool }> = [];
    for (const ch of this.channels) {
      if (ch.tools) {
        for (const tool of ch.tools) {
          result.push({ channel: ch.name, tool });
        }
      }
    }
    return result;
  }

  /**
   * Execute a tool on a specific channel.
   * Returns Result with ToolResult on success, or error string on failure.
   */
  async executeTool(
    channelName: string,
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<Result<ToolResult, string>> {
    const channel = this.byName.get(channelName);
    if (!channel) {
      return err(`channel "${channelName}" not found`);
    }

    if (!channel.tools) {
      return err(`channel "${channelName}" has no tools`);
    }

    const tool = channel.tools.find((t) => t.name === toolName);
    if (!tool) {
      return err(`tool "${toolName}" not found on channel "${channelName}"`);
    }

    if (!channel.executeTool) {
      return err(`channel "${channelName}" does not implement executeTool`);
    }

    try {
      const result = await channel.executeTool(toolName, params);
      return ok(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return ok({ success: false, error: message });
    }
  }
}
