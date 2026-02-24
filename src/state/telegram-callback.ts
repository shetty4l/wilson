/**
 * Persisted state for Telegram callback queries (inline button clicks).
 *
 * Used for deduplication — each callback is stored with its ID to prevent
 * duplicate processing on retries or redeliveries.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("telegram_callbacks")
export class TelegramCallback {
  /** Unique callback query ID from Telegram. */
  @Field("string") callbackQueryId: string = "";

  /** Chat ID where the callback originated. */
  @Field("number") chatId: number = 0;

  /** Message ID that contained the inline keyboard. */
  @Field("number") messageId: number = 0;

  /** User ID who clicked the button. */
  @Field("number") userId: number = 0;

  /** Callback data string from the button. */
  @Field("string") data: string = "";

  /** When this callback was processed. */
  @Field("date") processedAt: Date | null = null;
}
