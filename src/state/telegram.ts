/**
 * Persisted state for TelegramChannel.
 *
 * Survives restarts — cursor position and stats are preserved.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("telegram_channel_state")
export class TelegramChannelState {
  /** Telegram getUpdates offset (cursor for next update). */
  @Field("number") updateOffset: number | null = null;

  /** When the channel last synced with Telegram. */
  @Field("date") lastSyncAt: Date | null = null;

  /** When the channel last posted data to Cortex. */
  @Field("date") lastPostAt: Date | null = null;

  /** Number of messages delivered to Telegram. */
  @Field("number") messagesDelivered: number = 0;

  /** Current channel health status. */
  @Field("string") status: string = "healthy";

  /** Last error message if status is error/degraded. */
  @Field("string") error: string | null = null;

  /** Number of consecutive failures (timeouts or errors). Resets on success. */
  @Field("number") consecutiveFailures: number = 0;
}
