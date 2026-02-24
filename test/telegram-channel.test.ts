import { describe, expect, test } from "bun:test";
import { ok, type Result } from "@shetty4l/core/result";
import type {
  CortexClient,
  OutboxMessage,
  ReceivePayload,
  ReceiveResponse,
} from "../src/channels/cortex-client";
import { TelegramChannel } from "../src/channels/telegram/index";
import type { TelegramChannelConfig } from "../src/config";

// --- Mock CortexClient ---

interface MockCortexClient extends CortexClient {
  receiveCalls: ReceivePayload[];
  pollCalls: { channel: string; opts?: Record<string, unknown> }[];
  ackCalls: { messageId: string; leaseToken: string }[];
  pendingMessages: OutboxMessage[];
}

function makeMockCortex(): MockCortexClient {
  const receiveCalls: ReceivePayload[] = [];
  const pollCalls: { channel: string; opts?: Record<string, unknown> }[] = [];
  const ackCalls: { messageId: string; leaseToken: string }[] = [];
  const pendingMessages: OutboxMessage[] = [];

  return {
    receiveCalls,
    pollCalls,
    ackCalls,
    pendingMessages,
    receive: async (
      payload: ReceivePayload,
    ): Promise<Result<ReceiveResponse>> => {
      receiveCalls.push(payload);
      return ok({ eventId: "evt-1", status: "queued" as const });
    },
    pollOutbox: async (channel: string, opts?: Record<string, unknown>) => {
      pollCalls.push({ channel, opts });
      const msgs = [...pendingMessages];
      pendingMessages.length = 0;
      return ok(msgs);
    },
    ackOutbox: async (messageId: string, leaseToken: string) => {
      ackCalls.push({ messageId, leaseToken });
      return ok(undefined);
    },
  } as MockCortexClient;
}

// --- Default config ---

const DEFAULT_CONFIG: TelegramChannelConfig = {
  enabled: true,
  botToken: "test-bot-token",
  allowedUserIds: [123456, 789012],
  pollIntervalMs: 50,
  deliveryMaxBatch: 5,
  deliveryLeaseSeconds: 30,
};

// --- Tests ---

describe("TelegramChannel", () => {
  describe("channel properties", () => {
    test("has correct name and capabilities", () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      expect(channel.name).toBe("telegram");
      expect(channel.canReceive).toBe(true);
      expect(channel.canDeliver).toBe(true);
      expect(channel.mode).toBe("realtime");
      expect(channel.priority).toBe(0);
    });
  });

  describe("stats tracking", () => {
    test("getStats() returns initial state", () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      const stats = channel.getStats();
      expect(stats.lastSyncAt).toBeNull();
      expect(stats.lastPostAt).toBeNull();
      expect(stats.eventsPosted).toBe(0);
      expect(stats.status).toBe("healthy");
      expect(stats.error).toBeNull();
      expect(stats.consecutiveFailures).toBe(0);
    });

    test("getStats() returns a copy (immutable)", () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      const stats1 = channel.getStats();
      const stats2 = channel.getStats();
      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });

  describe("cursor persistence", () => {
    test("_getUpdateOffset() returns initial null", () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      expect(channel._getUpdateOffset()).toBeNull();
    });

    test("_setUpdateOffset() updates cursor", () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      channel._setUpdateOffset(12345);
      expect(channel._getUpdateOffset()).toBe(12345);

      channel._setUpdateOffset(null);
      expect(channel._getUpdateOffset()).toBeNull();
    });
  });

  describe("sync()", () => {
    test("is a no-op for realtime channel", async () => {
      const cortex = makeMockCortex();
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);

      // Should not throw and should not do anything
      await channel.sync();

      // No cortex calls should be made
      expect(cortex.receiveCalls.length).toBe(0);
      expect(cortex.pollCalls.length).toBe(0);
    });
  });
});

describe("TelegramChannel format utilities", () => {
  test("exports formatForTelegram", async () => {
    const { formatForTelegram } = await import(
      "../src/channels/telegram/index"
    );
    expect(typeof formatForTelegram).toBe("function");
  });

  test("exports chunkMarkdownV2", async () => {
    const { chunkMarkdownV2 } = await import("../src/channels/telegram/index");
    expect(typeof chunkMarkdownV2).toBe("function");
  });

  test("exports getUpdates", async () => {
    const { getUpdates } = await import("../src/channels/telegram/index");
    expect(typeof getUpdates).toBe("function");
  });

  test("exports sendMessage", async () => {
    const { sendMessage } = await import("../src/channels/telegram/index");
    expect(typeof sendMessage).toBe("function");
  });

  test("exports parseTelegramTopicKey", async () => {
    const { parseTelegramTopicKey } = await import(
      "../src/channels/telegram/index"
    );
    expect(typeof parseTelegramTopicKey).toBe("function");

    // Test basic parsing
    const result = parseTelegramTopicKey("12345:678");
    expect(result).toEqual({ chatId: 12345, threadId: 678 });

    const simpleResult = parseTelegramTopicKey("12345");
    expect(simpleResult).toEqual({ chatId: 12345, threadId: undefined });

    const invalidResult = parseTelegramTopicKey("invalid");
    expect(invalidResult).toBeNull();
  });
});

describe("parseTelegramTopicKey", () => {
  test("parses chat ID only", async () => {
    const { parseTelegramTopicKey } = await import(
      "../src/channels/telegram/index"
    );

    expect(parseTelegramTopicKey("12345")).toEqual({
      chatId: 12345,
      threadId: undefined,
    });
  });

  test("parses chat ID with thread ID", async () => {
    const { parseTelegramTopicKey } = await import(
      "../src/channels/telegram/index"
    );

    expect(parseTelegramTopicKey("12345:678")).toEqual({
      chatId: 12345,
      threadId: 678,
    });
  });

  test("handles negative chat IDs (groups)", async () => {
    const { parseTelegramTopicKey } = await import(
      "../src/channels/telegram/index"
    );

    expect(parseTelegramTopicKey("-100123456789")).toEqual({
      chatId: -100123456789,
      threadId: undefined,
    });

    expect(parseTelegramTopicKey("-100123456789:42")).toEqual({
      chatId: -100123456789,
      threadId: 42,
    });
  });

  test("returns null for invalid formats", async () => {
    const { parseTelegramTopicKey } = await import(
      "../src/channels/telegram/index"
    );

    expect(parseTelegramTopicKey("")).toBeNull();
    expect(parseTelegramTopicKey("abc")).toBeNull();
    expect(parseTelegramTopicKey("12345:abc")).toBeNull();
    expect(parseTelegramTopicKey("12345:678:extra")).toBeNull();
    expect(parseTelegramTopicKey("12.34")).toBeNull();
  });
});

describe("formatForTelegram", () => {
  test("converts markdown to Telegram MarkdownV2", async () => {
    const { formatForTelegram } = await import(
      "../src/channels/telegram/index"
    );

    // *text* in standard markdown is italic, becomes _text_ in MarkdownV2
    const result = formatForTelegram("Hello *world*!");
    expect(result).toContain("_world_");
    expect(result).toContain("\\!"); // ! is escaped in MarkdownV2
  });
});

describe("chunkMarkdownV2", () => {
  test("returns single chunk for short messages", async () => {
    const { chunkMarkdownV2 } = await import("../src/channels/telegram/index");

    const result = chunkMarkdownV2("Hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Hello world");
  });

  test("splits long messages", async () => {
    const { chunkMarkdownV2 } = await import("../src/channels/telegram/index");

    // Create a message longer than 4096 characters
    const longMessage = "x".repeat(5000);
    const result = chunkMarkdownV2(longMessage);
    expect(result.length).toBeGreaterThan(1);
  });
});

// --- Flow Tests ---
// These tests verify the ingestion, delivery, and error handling flows
// by testing the channel's internal methods indirectly through start/stop

import { spyOn } from "bun:test";
import type {
  TelegramMessage,
  TelegramUpdate,
} from "../src/channels/telegram/api";
import * as telegramApi from "../src/channels/telegram/api";

describe("TelegramChannel ingestion flow", () => {
  test("getUpdates → receive() flow works correctly", async () => {
    const cortex = makeMockCortex();

    // Mock getUpdates to return a single update
    const mockUpdate: TelegramUpdate = {
      update_id: 100,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: { id: 123456 }, // Allowed user
        chat: { id: 123456 },
        text: "Hello from Telegram",
      },
    };

    let getUpdatesCalls = 0;
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return [mockUpdate];
        }
        // After first call, return empty to avoid infinite loop
        // and wait a bit to let test assertions run
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
    await channel.start();

    // Wait for ingestion loop to process the update
    await new Promise((r) => setTimeout(r, 150));
    await channel.stop();

    // Verify getUpdates was called
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(1);

    // Verify receive was called with correct payload
    expect(cortex.receiveCalls.length).toBe(1);
    const payload = cortex.receiveCalls[0];
    expect(payload.channel).toBe("telegram");
    expect(payload.mode).toBe("realtime");
    const data = payload.data as { text: string; userId: number };
    expect(data.text).toBe("Hello from Telegram");
    expect(data.userId).toBe(123456);
    expect(payload.externalId).toBe("tg-100");

    // Verify cursor was advanced
    expect(channel._getUpdateOffset()).toBe(101);

    getUpdatesSpy.mockRestore();
  });

  test("filters out unauthorized users", async () => {
    const cortex = makeMockCortex();

    // Mock getUpdates with unauthorized user
    const mockUpdate: TelegramUpdate = {
      update_id: 200,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        from: { id: 999999 }, // Not in allowedUserIds
        chat: { id: 999999 },
        text: "Unauthorized message",
      },
    };

    let getUpdatesCalls = 0;
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return [mockUpdate];
        }
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
    await channel.start();
    await new Promise((r) => setTimeout(r, 150));
    await channel.stop();

    // receive() should NOT be called for unauthorized users
    expect(cortex.receiveCalls.length).toBe(0);
    // But cursor should still advance to skip the message
    expect(channel._getUpdateOffset()).toBe(201);

    getUpdatesSpy.mockRestore();
  });
});

describe("TelegramChannel delivery flow", () => {
  test("pollOutbox → sendMessage → ackOutbox flow works correctly", async () => {
    const cortex = makeMockCortex();

    // Add a pending message to the mock outbox
    cortex.pendingMessages.push({
      messageId: "msg-1",
      topicKey: "123456:789",
      text: "Hello from Cortex",
      leaseToken: "lease-token-1",
      payload: null,
    });

    // Mock sendMessage
    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (): Promise<TelegramMessage> => ({
        message_id: 42,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123456 },
        text: "Hello from Cortex",
      }),
    );

    // Mock getUpdates to return empty (we only test delivery)
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    );

    const channel = new TelegramChannel(cortex, {
      ...DEFAULT_CONFIG,
      pollIntervalMs: 10, // Fast polling for test
    });
    await channel.start();

    // Wait for delivery loop to process
    await new Promise((r) => setTimeout(r, 200));
    await channel.stop();

    // Verify pollOutbox was called
    expect(cortex.pollCalls.length).toBeGreaterThanOrEqual(1);
    expect(cortex.pollCalls[0].channel).toBe("telegram");

    // Verify sendMessage was called
    expect(sendMessageSpy).toHaveBeenCalled();
    const sendArgs = sendMessageSpy.mock.calls[0];
    expect(sendArgs[0]).toBe("test-bot-token");
    expect(sendArgs[1]).toBe(123456); // chatId
    expect(sendArgs[3]?.threadId).toBe(789); // threadId from topic

    // Verify ackOutbox was called
    expect(cortex.ackCalls.length).toBe(1);
    expect(cortex.ackCalls[0].messageId).toBe("msg-1");
    expect(cortex.ackCalls[0].leaseToken).toBe("lease-token-1");

    sendMessageSpy.mockRestore();
    getUpdatesSpy.mockRestore();
  });
});

describe("TelegramChannel error handling", () => {
  test("applies exponential backoff on ingestion errors", async () => {
    const cortex = makeMockCortex();

    let errorCount = 0;
    const errorTimes: number[] = [];

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        errorCount++;
        errorTimes.push(Date.now());
        if (errorCount <= 3) {
          throw new Error("Simulated API failure");
        }
        // After 3 errors, succeed and stop
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
    await channel.start();

    // Wait for at least one backoff cycle (1s min) plus buffer
    await new Promise((r) => setTimeout(r, 1200));
    await channel.stop();

    // Verify at least 2 errors occurred (first immediate, second after 1s backoff)
    expect(errorCount).toBeGreaterThanOrEqual(2);

    // Verify stats show degraded status
    const stats = channel.getStats();
    expect(stats.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(stats.status).toBe("degraded");

    // Verify backoff is applied (gap between errors should be ~1000ms)
    if (errorTimes.length >= 2) {
      const gap = errorTimes[1] - errorTimes[0];
      // First error should trigger 1s backoff minimum
      expect(gap).toBeGreaterThanOrEqual(900); // Allow some timing variance
    }

    getUpdatesSpy.mockRestore();
  });

  test("applies exponential backoff on delivery errors", async () => {
    const cortex = makeMockCortex();

    // Add a message that will fail to send
    cortex.pendingMessages.push({
      messageId: "msg-fail",
      topicKey: "123456",
      text: "Will fail",
      leaseToken: "lease-1",
      payload: null,
    });

    let sendErrorCount = 0;
    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async () => {
        sendErrorCount++;
        throw new Error("Simulated send failure");
      },
    );

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    const channel = new TelegramChannel(cortex, {
      ...DEFAULT_CONFIG,
      pollIntervalMs: 10,
    });
    await channel.start();

    // Wait for delivery to attempt and fail
    await new Promise((r) => setTimeout(r, 300));
    await channel.stop();

    // Verify send was attempted
    expect(sendErrorCount).toBeGreaterThanOrEqual(1);

    // Verify ack was NOT called (message should not be acked on failure)
    expect(cortex.ackCalls.length).toBe(0);

    sendMessageSpy.mockRestore();
    getUpdatesSpy.mockRestore();
  });
});
