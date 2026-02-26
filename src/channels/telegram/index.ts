/**
 * TelegramChannel — real-time bidirectional messaging via Telegram Bot API.
 *
 * Behavior:
 * - Ingestion: Long-polls Telegram via getUpdates(), posts messages to Cortex
 * - Delivery: Polls Cortex outbox, sends messages to Telegram, acks on success
 * - Cursor (updateOffset) persisted in Wilson SQLite via StateLoader
 * - Error handling: exponential backoff (base 1s, cap 30s)
 */

import { createLogger } from "@shetty4l/core/log";
import type { StateLoader } from "@shetty4l/core/state";
import type { TelegramChannelConfig } from "../../config";
import { TelegramChannelState } from "../../state/telegram";
import { TelegramCallback } from "../../state/telegram-callback";
import type { CortexClient, OutboxMessage } from "../cortex-client";
import type { Channel, ChannelStats } from "../index";
import {
  answerCallbackQuery,
  type CallbackQuery,
  editMessageReplyMarkup,
  getUpdates,
  type InlineKeyboardMarkup,
  parseTelegramTopicKey,
  sendMessage,
} from "./api";
import { chunkMarkdownV2 } from "./chunker";
import { formatForTelegram } from "./format";

// Re-export utilities for external use
export * from "./api";
export * from "./chunker";
export * from "./format";

const log = createLogger("wilson:telegram");

// --- Backoff constants ---

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

// --- Channel ---

export class TelegramChannel implements Channel {
  name = "telegram";
  canReceive = true;
  canDeliver = true;
  mode = "realtime" as const;
  priority = 0;

  private running = false;
  private abortController: AbortController | null = null;
  private stateLoader: StateLoader | null;
  private state: TelegramChannelState | null = null;

  // In-memory fallback for tests without stateLoader
  private memoryState = {
    updateOffset: null as number | null,
    lastSyncAt: null as Date | null,
    lastPostAt: null as Date | null,
    messagesDelivered: 0,
    status: "healthy" as string,
    error: null as string | null,
    consecutiveFailures: 0,
  };

  // Backoff state (not persisted - resets on restart)
  private ingestionBackoffMs = 0;
  private deliveryBackoffMs = 0;

  constructor(
    private cortex: CortexClient,
    private config: TelegramChannelConfig,
    stateLoader?: StateLoader,
  ) {
    this.stateLoader = stateLoader ?? null;
  }

  async start(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    log("starting telegram channel");

    // Load persisted state if stateLoader available
    if (this.stateLoader) {
      this.state = this.stateLoader.load(TelegramChannelState, "telegram");
    }

    // Start both loops (non-blocking)
    void this.runIngestionLoop();
    void this.runDeliveryLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    log("telegram channel stopped");
  }

  async sync(): Promise<void> {
    // For realtime channels, sync is a no-op (loops run continuously)
    log("sync called (no-op for realtime channel)");
  }

  getStats(): ChannelStats {
    const s = this.state ?? this.memoryState;
    return {
      lastSyncAt: s.lastSyncAt?.getTime() ?? null,
      lastPostAt: s.lastPostAt?.getTime() ?? null,
      eventsPosted: s.messagesDelivered,
      status: s.status as ChannelStats["status"],
      error: s.error,
      consecutiveFailures: s.consecutiveFailures,
    };
  }

  // --- Ingestion Loop ---

  private async runIngestionLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollTelegramUpdates();
        // Reset backoff and error state on success
        this.ingestionBackoffMs = 0;
        const s = this.state ?? this.memoryState;
        s.status = "healthy";
        s.error = null;
        s.consecutiveFailures = 0;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        log(`ingestion error: ${errorMsg}`);

        const s = this.state ?? this.memoryState;
        s.consecutiveFailures++;
        s.status = "degraded";
        s.error = errorMsg;

        // Apply exponential backoff
        this.ingestionBackoffMs = Math.min(
          BACKOFF_CAP_MS,
          Math.max(BACKOFF_BASE_MS, this.ingestionBackoffMs * 2),
        );
        log(`ingestion backoff: ${this.ingestionBackoffMs}ms`);
        await this.sleep(this.ingestionBackoffMs);
      }
    }
  }

  private async pollTelegramUpdates(): Promise<void> {
    const s = this.state ?? this.memoryState;
    const signal = this.abortController?.signal;

    // Get offset for getUpdates (null -> undefined)
    const offset = s.updateOffset ?? undefined;

    // Long-poll Telegram (20s timeout built into getUpdates)
    const updates = await getUpdates(this.config.botToken, offset, 20, signal);

    s.lastSyncAt = new Date();

    if (updates.length === 0) {
      // No updates, continue polling
      return;
    }

    // Process updates
    for (const update of updates) {
      if (!this.running) break;

      // Handle callback queries (inline button clicks)
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        s.updateOffset = update.update_id + 1;
        continue;
      }

      // Filter by allowed user IDs
      const userId = update.message?.from?.id;
      if (!userId || !this.config.allowedUserIds.includes(userId)) {
        log(`ignoring update from unauthorized user: ${userId}`);
        // Still advance cursor to skip this update
        s.updateOffset = update.update_id + 1;
        continue;
      }

      // Post to Cortex
      const messageText = update.message?.text;
      if (!messageText) {
        // No text message, skip but advance cursor
        s.updateOffset = update.update_id + 1;
        continue;
      }

      const chatId = update.message?.chat.id ?? userId;
      const threadId = update.message?.message_thread_id;
      const topicKey = threadId ? `${chatId}:${threadId}` : `${chatId}`;

      const result = await this.cortex.receive({
        channel: "telegram",
        externalId: `tg-${update.update_id}`,
        data: {
          text: messageText,
          userId,
          chatId,
          threadId,
          topicKey,
          messageId: update.message?.message_id,
          timestamp: update.message?.date,
        },
        occurredAt: new Date(
          (update.message?.date ?? Math.floor(Date.now() / 1000)) * 1000,
        ).toISOString(),
        mode: "realtime",
        metadata: { topicKey },
      });

      if (result.ok) {
        log(`posted update ${update.update_id} to cortex (topic: ${topicKey})`);
        s.lastPostAt = new Date();
        s.status = "healthy";
        s.error = null;
        s.consecutiveFailures = 0;
      } else {
        log(`cortex error for update ${update.update_id}: ${result.error}`);
        // Don't advance cursor on cortex error - will retry
        throw new Error(`Cortex error: ${result.error}`);
      }

      // Advance cursor after successful processing
      s.updateOffset = update.update_id + 1;
    }
  }

  private async handleCallbackQuery(query: CallbackQuery): Promise<void> {
    const s = this.state ?? this.memoryState;

    // Check for duplicate and record callback for deduplication
    // load() returns existing record or creates new one with defaults
    // If callbackQueryId is already set, this is a duplicate
    if (this.stateLoader) {
      const callback = this.stateLoader.load(TelegramCallback, query.id);
      if (callback.callbackQueryId !== "") {
        // Record already exists with data - this is a duplicate
        log(`duplicate callback query ${query.id}, skipping`);
        return;
      }
      // New record - populate and persist
      callback.callbackQueryId = query.id;
      callback.chatId = query.message?.chat.id ?? 0;
      callback.messageId = query.message?.message_id ?? 0;
      callback.userId = query.from.id;
      callback.data = query.data ?? "";
      callback.processedAt = new Date();
      await this.stateLoader.flush();
    }

    // Answer the callback to dismiss the loading spinner
    try {
      await answerCallbackQuery(this.config.botToken, query.id);
    } catch (e) {
      log(`failed to answer callback query ${query.id}: ${e}`);
      // Continue processing - answering is not critical
    }

    // Remove buttons from the message
    if (query.message) {
      try {
        await editMessageReplyMarkup(
          this.config.botToken,
          query.message.chat.id,
          query.message.message_id,
          null,
        );
      } catch (e) {
        log(`failed to remove buttons from message: ${e}`);
        // Continue processing - button removal is not critical
      }
    }

    // Filter by allowed user IDs
    const userId = query.from.id;
    if (!this.config.allowedUserIds.includes(userId)) {
      log(`ignoring callback from unauthorized user: ${userId}`);
      return;
    }

    // Derive topic key
    const chatId = query.message?.chat.id ?? 0;
    const threadId = query.message?.message_thread_id;
    const topicKey = threadId ? `${chatId}:${threadId}` : `${chatId}`;

    // Detect approval callbacks (pattern: approval:<id>:<action>)
    const approvalMatch = query.data?.match(/^approval:([^:]+):(\w+)$/);

    // Build data payload based on callback type
    const data = approvalMatch
      ? {
          type: "approval_response" as const,
          approvalId: approvalMatch[1],
          action: approvalMatch[2] as "approve" | "reject",
          originalMessageId: query.message?.message_id,
          originalMessageText: query.message?.text,
          userId,
          chatId,
          threadId,
          topicKey,
        }
      : {
          type: "button_callback" as const,
          callbackData: query.data,
          originalMessageId: query.message?.message_id,
          originalMessageText: query.message?.text,
          userId,
          chatId,
          threadId,
          topicKey,
        };

    // Post to Cortex
    // For approval_response, include type/approvalId/action in metadata
    // so cortex can detect it without parsing message text
    const metadata = approvalMatch
      ? {
          topicKey,
          type: "approval_response" as const,
          approvalId: approvalMatch[1],
          action: approvalMatch[2] as "approve" | "reject",
        }
      : { topicKey };

    const result = await this.cortex.receive({
      channel: "telegram",
      externalId: `callback:${query.id}`,
      data,
      occurredAt: new Date().toISOString(),
      mode: "realtime",
      metadata,
    });

    if (result.ok) {
      log(`posted callback ${query.id} to cortex (topic: ${topicKey})`);
      s.lastPostAt = new Date();
      s.status = "healthy";
      s.error = null;
      s.consecutiveFailures = 0;
    } else {
      log(`cortex error for callback ${query.id}: ${result.error}`);
      throw new Error(`Cortex error: ${result.error}`);
    }
  }

  // --- Delivery Loop ---

  private async runDeliveryLoop(): Promise<void> {
    const pollInterval = this.config.pollIntervalMs ?? 250;

    while (this.running) {
      try {
        const delivered = await this.deliverOutboxMessages();
        // Reset backoff and error state on success (even if no messages)
        this.deliveryBackoffMs = 0;
        const s = this.state ?? this.memoryState;
        s.status = "healthy";
        s.error = null;
        if (delivered === 0) {
          // No messages, wait before next poll
          await this.sleep(pollInterval);
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        log(`delivery error: ${errorMsg}`);

        const s = this.state ?? this.memoryState;
        s.status = "degraded";
        s.error = errorMsg;

        // Apply exponential backoff
        this.deliveryBackoffMs = Math.min(
          BACKOFF_CAP_MS,
          Math.max(BACKOFF_BASE_MS, this.deliveryBackoffMs * 2),
        );
        log(`delivery backoff: ${this.deliveryBackoffMs}ms`);
        await this.sleep(this.deliveryBackoffMs);
      }
    }
  }

  private async deliverOutboxMessages(): Promise<number> {
    const s = this.state ?? this.memoryState;

    // Poll Cortex outbox
    const pollResult = await this.cortex.pollOutbox("telegram", {
      max: this.config.deliveryMaxBatch ?? 20,
      leaseSeconds: this.config.deliveryLeaseSeconds ?? 60,
    });

    if (!pollResult.ok) {
      throw new Error(`Cortex poll error: ${pollResult.error}`);
    }

    const messages = pollResult.value;
    if (messages.length === 0) {
      return 0;
    }

    let delivered = 0;

    for (const msg of messages) {
      if (!this.running) break;

      try {
        await this.deliverMessage(msg);
        delivered++;
        s.messagesDelivered++;
      } catch (e) {
        // Log but continue with next message
        const errorMsg = e instanceof Error ? e.message : String(e);
        log(`failed to deliver message ${msg.messageId}: ${errorMsg}`);
        // Don't ack - message will be retried after lease expires
      }
    }

    return delivered;
  }

  private async deliverMessage(msg: OutboxMessage): Promise<void> {
    // Parse topic key to get chat ID and optional thread ID
    const topic = parseTelegramTopicKey(msg.topicKey);
    if (!topic) {
      log(`invalid topic key: ${msg.topicKey}, acking to skip`);
      await this.cortex.ackOutbox(msg.messageId, msg.leaseToken);
      return;
    }

    // Format and chunk the message
    const formatted = formatForTelegram(msg.text);
    const chunks = chunkMarkdownV2(formatted);

    // Build inline keyboard from payload.buttons if present
    const buttons = msg.payload?.buttons as
      | Array<{ label: string; data: string }>
      | undefined;
    const replyMarkup: InlineKeyboardMarkup | undefined = buttons?.length
      ? {
          inline_keyboard: [
            buttons.map((b) => ({ text: b.label, callback_data: b.data })),
          ],
        }
      : undefined;

    // Send each chunk (only last chunk gets buttons)
    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      await sendMessage(this.config.botToken, topic.chatId, chunks[i], {
        threadId: topic.threadId,
        parseMode: "MarkdownV2",
        replyMarkup: isLastChunk ? replyMarkup : undefined,
      });
    }

    // Ack successful delivery
    const ackResult = await this.cortex.ackOutbox(
      msg.messageId,
      msg.leaseToken,
    );
    if (!ackResult.ok) {
      log(`failed to ack message ${msg.messageId}: ${ackResult.error}`);
      // Don't throw - message was delivered, ack failure is non-fatal
    } else {
      log(`delivered message ${msg.messageId} to ${msg.topicKey}`);
    }
  }

  // --- Helpers ---

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow abort to cancel sleep
      this.abortController?.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // --- Test helpers ---

  /** @internal — exposed for testing */
  _getUpdateOffset(): number | null {
    return this.state?.updateOffset ?? this.memoryState.updateOffset;
  }

  /** @internal — exposed for testing */
  _setUpdateOffset(offset: number | null): void {
    if (this.state) {
      this.state.updateOffset = offset;
    } else {
      this.memoryState.updateOffset = offset;
    }
  }
}
