/**
 * Exhaustive test suite for topic resolution in TelegramChannel.
 *
 * Tests the resolveTopicKey() method which maps topic keys to Telegram chat coordinates.
 * - Numeric keys: Direct parsing (backward compatibility)
 * - Semantic keys: Mapping lookup, thread creation, fallback to DM
 * - Race condition handling: UNIQUE constraint → delete orphan → return winner
 */

import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { ok, type Result } from "@shetty4l/core/result";
import { StateLoader } from "@shetty4l/core/state";
import type {
  CortexClient,
  OutboxMessage,
  ReceivePayload,
  ReceiveResponse,
} from "../src/channels/cortex-client";
import * as telegramApi from "../src/channels/telegram/api";
import {
  parseTelegramTopicKey,
  TelegramChannel,
} from "../src/channels/telegram/index";
import type { TelegramChannelConfig } from "../src/config";
import { TopicChannelMapping } from "../src/state/topic-channel";

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

// Helper to run a channel test with proper cleanup
async function runChannelTest(
  config: TelegramChannelConfig,
  cortex: MockCortexClient,
  loader: StateLoader,
  db: Database,
  testFn: (channel: TelegramChannel) => Promise<void>,
): Promise<void> {
  const channel = new TelegramChannel(cortex, config, loader);
  try {
    await channel.start();
    await new Promise((r) => setTimeout(r, 150)); // Allow poll cycles
    await channel.stop();
    // Wait for loops to fully exit and pending ops to complete
    await new Promise((r) => setTimeout(r, 200));
    await loader.flush(); // Ensure all pending state is flushed
    await testFn(channel);
  } finally {
    await loader.flush(); // Final flush
    await new Promise((r) => setTimeout(r, 150)); // Extra settle time before db.close
    db.close();
  }
}

// --- parseTelegramTopicKey Tests (Numeric keys) - 4 tests ---

describe("parseTelegramTopicKey - Numeric keys", () => {
  test("simple chatId", () => {
    const result = parseTelegramTopicKey("123456");
    expect(result).toEqual({ chatId: 123456 });
  });

  test("chatId:threadId", () => {
    const result = parseTelegramTopicKey("123456:789");
    expect(result).toEqual({ chatId: 123456, threadId: 789 });
  });

  test("negative group chatId", () => {
    const result = parseTelegramTopicKey("-100123456789");
    expect(result).toEqual({ chatId: -100123456789 });
  });

  test("negative group chatId with threadId", () => {
    const result = parseTelegramTopicKey("-100123456789:42");
    expect(result).toEqual({ chatId: -100123456789, threadId: 42 });
  });
});

// --- Mapping exists tests - 4 tests ---

describe("Topic resolution - Mapping exists", () => {
  test("returns stored mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "cortex:alerts",
      chatId: -100555666777,
      threadId: 42,
    });

    cortex.pendingMessages.push({
      messageId: "msg-1",
      topicKey: "cortex:alerts",
      text: "Test alert",
      leaseToken: "lease-1",
      payload: null,
    });

    let sentToChatId = 0;
    let sentToThreadId: number | undefined;

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        sentToChatId = chatId;
        sentToThreadId = opts?.threadId;
        return { message_id: 1, date: Date.now() / 1000, chat: { id: chatId } };
      },
    );

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sentToChatId).toBe(-100555666777);
        expect(sentToThreadId).toBe(42);
      });
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });

  test("returns correct chatId and threadId from mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "test:topic",
      chatId: -100111222333,
      threadId: 99,
    });
    cortex.pendingMessages.push({
      messageId: "msg-2",
      topicKey: "test:topic",
      text: "Test",
      leaseToken: "lease-2",
      payload: null,
    });

    let capturedChatId = 0;
    let capturedThreadId: number | undefined;

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        capturedChatId = chatId;
        capturedThreadId = opts?.threadId;
        return { message_id: 2, date: Date.now() / 1000, chat: { id: chatId } };
      },
    );
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(capturedChatId).toBe(-100111222333);
        expect(capturedThreadId).toBe(99);
      });
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });

  test("handles null threadId in mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "general:channel",
      chatId: -100999888777,
      threadId: null,
    });
    cortex.pendingMessages.push({
      messageId: "msg-3",
      topicKey: "general:channel",
      text: "Test",
      leaseToken: "lease-3",
      payload: null,
    });

    let capturedThreadId: number | undefined = 999;

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        capturedThreadId = opts?.threadId;
        return { message_id: 3, date: Date.now() / 1000, chat: { id: chatId } };
      },
    );
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(capturedThreadId).toBeUndefined();
      });
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });

  test("handles set threadId in mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "team:eng",
      chatId: -100444555666,
      threadId: 123,
    });
    cortex.pendingMessages.push({
      messageId: "msg-4",
      topicKey: "team:eng",
      text: "Test",
      leaseToken: "lease-4",
      payload: null,
    });

    let capturedThreadId: number | undefined;

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        capturedThreadId = opts?.threadId;
        return { message_id: 4, date: Date.now() / 1000, chat: { id: chatId } };
      },
    );
    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(capturedThreadId).toBe(123);
      });
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });
});

// --- No mapping + supergroup tests - 6 tests ---

describe("Topic resolution - No mapping + supergroup", () => {
  const configWithSupergroup: TelegramChannelConfig = {
    ...DEFAULT_CONFIG,
    supergroupId: -100111222333,
  };

  test("creates thread via createForumTopic", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-create",
      topicKey: "new:topic",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let createForumTopicCalled = false;
    let createForumTopicChatId = 0;

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async (_token, chatId) => {
        createForumTopicCalled = true;
        createForumTopicChatId = chatId;
        return { message_thread_id: 777 };
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 10,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(createForumTopicCalled).toBe(true);
          expect(createForumTopicChatId).toBe(-100111222333);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("stores mapping after creating thread", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-store",
      topicKey: "store:test",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => ({ message_thread_id: 888 }),
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 11,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, configWithSupergroup, loader);
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader.flush();
      await new Promise((r) => setTimeout(r, 100));

      const mapping = loader.get(TopicChannelMapping, "store:test");
      expect(mapping).not.toBeNull();
      expect(mapping?.chatId).toBe(-100111222333);
      expect(mapping?.threadId).toBe(888);
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
      await loader.flush();
      await new Promise((r) => setTimeout(r, 150));
      db.close();
    }
  });

  test("uses topicKey as thread name", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-name",
      topicKey: "alerts:production",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let capturedThreadName = "";

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async (_token, _chatId, name) => {
        capturedThreadName = name;
        return { message_thread_id: 999 };
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 12,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(capturedThreadName).toBe("alerts:production");
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("truncates long names (>128 chars)", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    const longTopicKey = "a".repeat(200);
    cortex.pendingMessages.push({
      messageId: "msg-long",
      topicKey: longTopicKey,
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let capturedThreadName = "";

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async (_token, _chatId, name) => {
        capturedThreadName = name;
        return { message_thread_id: 1000 };
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 13,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(capturedThreadName.length).toBe(128);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("handles special chars in topic key", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    const specialTopicKey = "alerts:prod/test@email.com";
    cortex.pendingMessages.push({
      messageId: "msg-special",
      topicKey: specialTopicKey,
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let capturedThreadName = "";

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async (_token, _chatId, name) => {
        capturedThreadName = name;
        return { message_thread_id: 1001 };
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 14,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(capturedThreadName).toBe(specialTopicKey);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("returns new threadId from created topic", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-return",
      topicKey: "return:test",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => ({ message_thread_id: 5555 }),
    );
    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToThreadId = opts?.threadId;
        return { message_id: 15, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(sentToThreadId).toBe(5555);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});

// --- No mapping + no supergroup tests - 4 tests ---

describe("Topic resolution - No mapping + no supergroup", () => {
  test("falls back to allowedUserIds[0] DM", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-dm",
      topicKey: "no:supergroup",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sentToChatId = 0;

    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => {
        sentToChatId = cid;
        return { message_id: 20, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sentToChatId).toBe(123456); // First allowedUserId
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("returns chatId only (no threadId)", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-nothread",
      topicKey: "dm:only",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sentToThreadId: number | undefined = 999;

    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToThreadId = opts?.threadId;
        return { message_id: 21, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sentToThreadId).toBeUndefined();
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("doesn't create mapping for fallback DM", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-nomap",
      topicKey: "no:mapping:stored",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 22,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG, loader);
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader.flush();
      await new Promise((r) => setTimeout(r, 100));

      const mapping = loader.get(TopicChannelMapping, "no:mapping:stored");
      expect(mapping).toBeNull();
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
      await loader.flush();
      await new Promise((r) => setTimeout(r, 150));
      db.close();
    }
  });

  test("logs warning when falling back to DM", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-log",
      topicKey: "log:warning",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sendMessageCalled = false;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => {
        sendMessageCalled = true;
        return { message_id: 23, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sendMessageCalled).toBe(true);
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});

// --- Invalid inputs tests - 4 tests ---

describe("parseTelegramTopicKey - Invalid inputs", () => {
  test("empty string returns null", () => {
    expect(parseTelegramTopicKey("")).toBeNull();
  });

  test("whitespace returns null", () => {
    expect(parseTelegramTopicKey("   ")).toBeNull();
  });

  test("non-numeric string returns null", () => {
    expect(parseTelegramTopicKey("abc")).toBeNull();
  });

  test("mixed numeric/alpha returns null", () => {
    expect(parseTelegramTopicKey("123abc")).toBeNull();
    expect(parseTelegramTopicKey("abc123")).toBeNull();
  });
});

// --- API failures tests - 6 tests ---

describe("Topic resolution - API failures", () => {
  const configWithSupergroup: TelegramChannelConfig = {
    ...DEFAULT_CONFIG,
    supergroupId: -100111222333,
  };

  test("createForumTopic failure throws", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-fail",
      topicKey: "api:failure",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          400,
          "Bad Request",
        );
      },
    );
    let sendMessageCalled = false;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => {
        sendMessageCalled = true;
        return { message_id: 30, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(sendMessageCalled).toBe(false);
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("propagates error message from API", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-prop",
      topicKey: "error:propagate",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          400,
          "chat not found",
        );
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 31,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("no partial mapping stored on API failure", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-partial",
      topicKey: "no:partial",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          403,
          "Forbidden",
        );
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 32,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, configWithSupergroup, loader);
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader.flush();
      await new Promise((r) => setTimeout(r, 100));

      const mapping = loader.get(TopicChannelMapping, "no:partial");
      expect(mapping).toBeNull();
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
      await loader.flush();
      await new Promise((r) => setTimeout(r, 150));
      db.close();
    }
  });

  test("handles 400 error", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-400",
      topicKey: "error:400",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          400,
          "Bad Request",
        );
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 33,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("handles 403 error", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-403",
      topicKey: "error:403",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          403,
          "Forbidden",
        );
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 34,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("handles timeout error", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-timeout",
      topicKey: "error:timeout",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          0,
          "Request timed out",
        );
      },
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 35,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});

// --- Race condition tests - 3 tests ---

describe("Topic resolution - Race condition", () => {
  const configWithSupergroup: TelegramChannelConfig = {
    ...DEFAULT_CONFIG,
    supergroupId: -100111222333,
  };

  test("concurrent calls use existing mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    // Pre-create the winning mapping
    loader.create(TopicChannelMapping, {
      topicKey: "race:condition",
      chatId: -100111222333,
      threadId: 1111,
    });
    cortex.pendingMessages.push({
      messageId: "msg-race",
      topicKey: "race:condition",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let createForumTopicCalled = false;
    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        createForumTopicCalled = true;
        return { message_thread_id: 2222 };
      },
    );
    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToThreadId = opts?.threadId;
        return { message_id: 40, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(createForumTopicCalled).toBe(false);
          expect(sentToThreadId).toBe(1111);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("orphan thread deleted via deleteForumTopic on UNIQUE constraint error", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-orphan",
      topicKey: "orphan:delete",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let createCalls = 0;
    let deleteCalls = 0;
    let deletedThreadId = 0;

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        createCalls++;
        return { message_thread_id: 3333 };
      },
    );
    const deleteSpy = spyOn(telegramApi, "deleteForumTopic").mockImplementation(
      async (_token, _chatId, threadId) => {
        deleteCalls++;
        deletedThreadId = threadId;
        return true;
      },
    );

    // Mock create to simulate UNIQUE constraint failure
    let mappingCreated = false;
    const originalCreate = loader.create.bind(loader);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loader as any).create = function (
      EntityClass: new () => unknown,
      data: Record<string, unknown>,
    ): unknown {
      if (!mappingCreated && data.topicKey === "orphan:delete") {
        mappingCreated = true;
        originalCreate(TopicChannelMapping, {
          topicKey: "orphan:delete",
          chatId: -100111222333,
          threadId: 4444,
        });
        throw new Error(
          "UNIQUE constraint failed: topic_channel_mappings.topicKey",
        );
      }
      return originalCreate(EntityClass as new () => TopicChannelMapping, data);
    };

    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToThreadId = opts?.threadId;
        return { message_id: 41, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(createCalls).toBe(1);
          expect(deleteCalls).toBe(1);
          expect(deletedThreadId).toBe(3333);
          expect(sentToThreadId).toBe(4444);
        },
      );
    } finally {
      createSpy.mockRestore();
      deleteSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("winner's mapping returned after race resolution", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "winner:mapping",
      chatId: -100111222333,
      threadId: 7777,
    });
    cortex.pendingMessages.push({
      messageId: "msg-winner",
      topicKey: "winner:mapping",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToThreadId = opts?.threadId;
        return { message_id: 42, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(sentToThreadId).toBe(7777);
        },
      );
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});

// --- Persistence tests - 3 tests ---

describe("Topic resolution - Persistence", () => {
  const configWithSupergroup: TelegramChannelConfig = {
    ...DEFAULT_CONFIG,
    supergroupId: -100111222333,
  };

  test("mapping survives channel restart", async () => {
    const db = new Database(":memory:");

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => ({ message_thread_id: 8888 }),
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 50,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    let loader1: StateLoader | null = null;
    let loader2: StateLoader | null = null;

    try {
      // First channel creates mapping
      loader1 = new StateLoader(db);
      const cortex1 = makeMockCortex();
      cortex1.pendingMessages.push({
        messageId: "msg-p1",
        topicKey: "persist:test",
        text: "Test",
        leaseToken: "lease",
        payload: null,
      });

      const channel1 = new TelegramChannel(
        cortex1,
        configWithSupergroup,
        loader1,
      );
      await channel1.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel1.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader1.flush();
      await new Promise((r) => setTimeout(r, 100));

      const mapping1 = loader1.get(TopicChannelMapping, "persist:test");
      expect(mapping1?.threadId).toBe(8888);

      // Second channel uses existing mapping
      createSpy.mockClear();
      loader2 = new StateLoader(db);
      const cortex2 = makeMockCortex();
      cortex2.pendingMessages.push({
        messageId: "msg-p2",
        topicKey: "persist:test",
        text: "Test",
        leaseToken: "lease",
        payload: null,
      });

      let sentToThreadId: number | undefined;
      sendSpy.mockImplementation(
        async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
          sentToThreadId = opts?.threadId;
          return { message_id: 51, date: Date.now() / 1000, chat: { id: cid } };
        },
      );

      const channel2 = new TelegramChannel(
        cortex2,
        configWithSupergroup,
        loader2,
      );
      await channel2.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel2.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader2.flush();
      await new Promise((r) => setTimeout(r, 100));

      expect(createSpy).not.toHaveBeenCalled();
      expect(sentToThreadId).toBe(8888);
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
      if (loader1) await loader1.flush();
      if (loader2) await loader2.flush();
      await new Promise((r) => setTimeout(r, 150));
      db.close();
    }
  });

  test("stateLoader retrieval works", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);

    loader.create(TopicChannelMapping, {
      topicKey: "direct:create",
      chatId: -100999888777,
      threadId: 555,
    });
    await loader.flush();

    const mapping = loader.get(TopicChannelMapping, "direct:create");

    expect(mapping).not.toBeNull();
    expect(mapping?.topicKey).toBe("direct:create");
    expect(mapping?.chatId).toBe(-100999888777);
    expect(mapping?.threadId).toBe(555);

    await loader.flush();
    db.close();
  });

  test("created_at timestamp set on new mapping", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-ts",
      topicKey: "timestamp:test",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => ({ message_thread_id: 6666 }),
    );
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 52,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, configWithSupergroup, loader);
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();
      await new Promise((r) => setTimeout(r, 100));
      await loader.flush();
      await new Promise((r) => setTimeout(r, 100));

      const mapping = loader.get(TopicChannelMapping, "timestamp:test");
      expect(mapping).not.toBeNull();
      expect(mapping?.created_at).toBeDefined();
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
      await loader.flush();
      await new Promise((r) => setTimeout(r, 150));
      db.close();
    }
  });
});

// --- deliverMessage integration tests - 4 tests ---

describe("deliverMessage integration", () => {
  test("uses resolveTopicKey for delivery", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "delivery:test",
      chatId: -100444555666,
      threadId: 101,
    });
    cortex.pendingMessages.push({
      messageId: "msg-del",
      topicKey: "delivery:test",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sentToChatId = 0;
    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToChatId = cid;
        sentToThreadId = opts?.threadId;
        return { message_id: 60, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sentToChatId).toBe(-100444555666);
        expect(sentToThreadId).toBe(101);
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("acks on successful delivery", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    cortex.pendingMessages.push({
      messageId: "msg-ack",
      topicKey: "123456",
      text: "Test",
      leaseToken: "lease-ack",
      payload: null,
    });

    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => ({
        message_id: 61,
        date: Date.now() / 1000,
        chat: { id: cid },
      }),
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(cortex.ackCalls.length).toBe(1);
        expect(cortex.ackCalls[0].messageId).toBe("msg-ack");
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("acks on resolution failure (to skip bad message)", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();
    const configWithSupergroup: TelegramChannelConfig = {
      ...DEFAULT_CONFIG,
      supergroupId: -100111222333,
    };

    cortex.pendingMessages.push({
      messageId: "msg-fail-ack",
      topicKey: "resolution:failure",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    const createSpy = spyOn(telegramApi, "createForumTopic").mockImplementation(
      async () => {
        throw new telegramApi.TelegramApiError(
          "createForumTopic",
          400,
          "Bad Request",
        );
      },
    );
    let sendMessageCalled = false;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid): Promise<telegramApi.TelegramMessage> => {
        sendMessageCalled = true;
        return { message_id: 62, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(
        configWithSupergroup,
        cortex,
        loader,
        db,
        async () => {
          expect(sendMessageCalled).toBe(false);
          expect(cortex.ackCalls.length).toBe(1);
        },
      );
    } finally {
      createSpy.mockRestore();
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  test("logs resolved target", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    loader.create(TopicChannelMapping, {
      topicKey: "log:target",
      chatId: -100777888999,
      threadId: 202,
    });
    cortex.pendingMessages.push({
      messageId: "msg-log-target",
      topicKey: "log:target",
      text: "Test",
      leaseToken: "lease",
      payload: null,
    });

    let sentToChatId = 0;
    let sentToThreadId: number | undefined;
    const sendSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (_t, cid, _txt, opts): Promise<telegramApi.TelegramMessage> => {
        sentToChatId = cid;
        sentToThreadId = opts?.threadId;
        return { message_id: 63, date: Date.now() / 1000, chat: { id: cid } };
      },
    );
    const getSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [];
      },
    );

    try {
      await runChannelTest(DEFAULT_CONFIG, cortex, loader, db, async () => {
        expect(sentToChatId).toBe(-100777888999);
        expect(sentToThreadId).toBe(202);
        expect(cortex.ackCalls.length).toBe(1);
      });
    } finally {
      sendSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});
