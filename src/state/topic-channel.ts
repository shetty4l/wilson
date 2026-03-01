/**
 * Persisted collection for topic-to-channel mappings.
 *
 * Maps semantic topic keys (e.g., "cortex:alerts", "daily:standup")
 * to Telegram chat coordinates (chatId + optional threadId for forum topics).
 * Enables Wilson to create and reuse Telegram forum threads automatically.
 *
 * Note: created_at and updated_at are auto-managed by @PersistedCollection.
 */

import {
  CollectionEntity,
  CollectionField,
  Id,
  PersistedCollection,
} from "@shetty4l/core/state";

@PersistedCollection("topic_channel_mappings")
export class TopicChannelMapping extends CollectionEntity {
  /** Semantic topic key (e.g., "cortex:alerts", "daily:standup"). Primary key. */
  @Id() topicKey: string = "";

  /** Telegram chat ID (group/supergroup). */
  @CollectionField("number") chatId: number = 0;

  /** Telegram message thread ID for forum topics (null for non-forum chats). */
  @CollectionField("number") threadId: number | null = null;

  // Note: created_at is auto-managed by @PersistedCollection, accessible via this.created_at

  async save(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }

  async delete(): Promise<void> {
    throw new Error("Not bound to StateLoader");
  }
}
