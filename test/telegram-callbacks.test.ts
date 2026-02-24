/**
 * Tests for Telegram callback query (inline button) handling.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ok, type Result } from "@shetty4l/core/result";
import { StateLoader } from "@shetty4l/core/state";
import type {
  CortexClient,
  OutboxMessage,
  ReceivePayload,
  ReceiveResponse,
} from "../src/channels/cortex-client";
import * as telegramApi from "../src/channels/telegram/api";
import { TelegramChannel } from "../src/channels/telegram/index";
import type { TelegramChannelConfig } from "../src/config";
import { TelegramCallback } from "../src/state/telegram-callback";

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

// --- TelegramCallback State Tests ---

describe("TelegramCallback state class", () => {
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  test("initializes with defaults", () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    const callback = loader.load(TelegramCallback, "test-callback-id");

    expect(callback.callbackQueryId).toBe("");
    expect(callback.chatId).toBe(0);
    expect(callback.messageId).toBe(0);
    expect(callback.userId).toBe(0);
    expect(callback.data).toBe("");
    expect(callback.processedAt).toBe(null);
  });

  test("persists and restores all fields", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // First load - set values
    const callback1 = loader.load(TelegramCallback, "cb-123");
    callback1.callbackQueryId = "cb-123";
    callback1.chatId = 12345;
    callback1.messageId = 67890;
    callback1.userId = 111222;
    callback1.data = "approve:request-1";
    callback1.processedAt = new Date("2026-02-24T10:00:00Z");
    await loader.flush();

    // Second load - verify restored
    const loader2 = new StateLoader(db);
    const callback2 = loader2.load(TelegramCallback, "cb-123");
    expect(callback2.callbackQueryId).toBe("cb-123");
    expect(callback2.chatId).toBe(12345);
    expect(callback2.messageId).toBe(67890);
    expect(callback2.userId).toBe(111222);
    expect(callback2.data).toBe("approve:request-1");
    expect(callback2.processedAt?.toISOString()).toBe(
      "2026-02-24T10:00:00.000Z",
    );
  });

  test("exists() returns true for existing callback", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    // Create a callback
    const callback = loader.load(TelegramCallback, "cb-exists");
    callback.callbackQueryId = "cb-exists";
    callback.data = "test-data";
    await loader.flush();

    // Check exists
    const loader2 = new StateLoader(db);
    const exists = await loader2.exists(TelegramCallback, "cb-exists");
    expect(exists).toBe(true);
  });

  test("exists() returns false for non-existing callback", async () => {
    db = new Database(":memory:");
    const loader = new StateLoader(db);

    const exists = await loader.exists(TelegramCallback, "cb-does-not-exist");
    expect(exists).toBe(false);
  });
});

// --- Callback Query Handling Tests ---
// These tests verify callback query processing including deduplication,
// answering callbacks, removing buttons, and cortex payload structure.

describe("TelegramChannel callback query handling", () => {
  test("duplicate callback rejected when exists() returns true", async () => {
    const db = new Database(":memory:");
    const loader = new StateLoader(db);
    const cortex = makeMockCortex();

    // Pre-create a callback to simulate duplicate
    const existingCallback = loader.load(TelegramCallback, "dup-callback-123");
    existingCallback.callbackQueryId = "dup-callback-123";
    existingCallback.data = "already-processed";
    await loader.flush();

    // Mock getUpdates to return a callback with the same ID
    const mockUpdate: telegramApi.TelegramUpdate = {
      update_id: 500,
      callback_query: {
        id: "dup-callback-123",
        from: { id: 123456 },
        message: {
          message_id: 100,
          chat: { id: 123456 },
        },
        data: "approve:request-1",
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

    const answerSpy = spyOn(
      telegramApi,
      "answerCallbackQuery",
    ).mockImplementation(async () => true);

    const editSpy = spyOn(
      telegramApi,
      "editMessageReplyMarkup",
    ).mockImplementation(async () => true);

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG, loader);
      await channel.start();
      await new Promise((r) => setTimeout(r, 150));
      await channel.stop();
      // Wait for async operations to settle
      await new Promise((r) => setTimeout(r, 100));

      // Cortex receive should NOT be called for duplicate
      expect(cortex.receiveCalls.length).toBe(0);
    } finally {
      getUpdatesSpy.mockRestore();
      answerSpy.mockRestore();
      editSpy.mockRestore();
      // Wait for any pending async operations before closing db
      await new Promise((r) => setTimeout(r, 100));
      db.close();
    }
  });

  test("answerCallbackQuery called with correct query ID", async () => {
    const cortex = makeMockCortex();
    let answerCalledWithId = "";

    const mockUpdate: telegramApi.TelegramUpdate = {
      update_id: 600,
      callback_query: {
        id: "callback-answer-test-unique",
        from: { id: 123456 },
        message: {
          message_id: 200,
          chat: { id: 123456 },
        },
        data: "test-data",
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

    const answerSpy = spyOn(
      telegramApi,
      "answerCallbackQuery",
    ).mockImplementation(async (_token, queryId) => {
      answerCalledWithId = queryId;
      return true;
    });

    const editSpy = spyOn(
      telegramApi,
      "editMessageReplyMarkup",
    ).mockImplementation(async () => true);

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
      await channel.start();
      await new Promise((r) => setTimeout(r, 150));
      await channel.stop();

      // Verify answerCallbackQuery was called with correct ID
      expect(answerCalledWithId).toBe("callback-answer-test-unique");
    } finally {
      getUpdatesSpy.mockRestore();
      answerSpy.mockRestore();
      editSpy.mockRestore();
    }
  });

  test("editMessageReplyMarkup called with null to remove buttons", async () => {
    const cortex = makeMockCortex();
    let editCalledWith: {
      chatId: number;
      messageId: number;
      markup: telegramApi.InlineKeyboardMarkup | null;
    } | null = null;

    const mockUpdate: telegramApi.TelegramUpdate = {
      update_id: 700,
      callback_query: {
        id: "callback-remove-buttons-unique",
        from: { id: 123456 },
        message: {
          message_id: 300,
          chat: { id: 789456 },
        },
        data: "remove-test",
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

    const answerSpy = spyOn(
      telegramApi,
      "answerCallbackQuery",
    ).mockImplementation(async () => true);

    const editSpy = spyOn(
      telegramApi,
      "editMessageReplyMarkup",
    ).mockImplementation(async (_token, chatId, messageId, markup) => {
      editCalledWith = { chatId, messageId, markup };
      return true;
    });

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
      await channel.start();
      await new Promise((r) => setTimeout(r, 150));
      await channel.stop();

      // Verify editMessageReplyMarkup was called with null
      expect(editCalledWith).toBeTruthy();
      expect(editCalledWith!.chatId).toBe(789456);
      expect(editCalledWith!.messageId).toBe(300);
      expect(editCalledWith!.markup).toBe(null);
    } finally {
      getUpdatesSpy.mockRestore();
      answerSpy.mockRestore();
      editSpy.mockRestore();
    }
  });

  test("inbox payload has correct structure with type: button_callback", async () => {
    const cortex = makeMockCortex();

    const mockUpdate: telegramApi.TelegramUpdate = {
      update_id: 800,
      callback_query: {
        id: "callback-payload-test-unique",
        from: { id: 123456 },
        message: {
          message_id: 400,
          chat: { id: 123456 },
          message_thread_id: 789,
          text: "Original message text",
        },
        data: "approve:request-42",
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

    const answerSpy = spyOn(
      telegramApi,
      "answerCallbackQuery",
    ).mockImplementation(async () => true);

    const editSpy = spyOn(
      telegramApi,
      "editMessageReplyMarkup",
    ).mockImplementation(async () => true);

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
      await channel.start();
      await new Promise((r) => setTimeout(r, 150));
      await channel.stop();

      // Verify receive was called with correct payload
      expect(cortex.receiveCalls.length).toBe(1);
      const payload = cortex.receiveCalls[0];

      expect(payload.channel).toBe("telegram");
      expect(payload.externalId).toBe("callback:callback-payload-test-unique");
      expect(payload.mode).toBe("realtime");

      const data = payload.data as {
        type: string;
        callbackData: string;
        originalMessageId: number;
        originalMessageText: string;
        userId: number;
        chatId: number;
        threadId: number;
        topicKey: string;
      };

      expect(data.type).toBe("button_callback");
      expect(data.callbackData).toBe("approve:request-42");
      expect(data.originalMessageId).toBe(400);
      expect(data.originalMessageText).toBe("Original message text");
      expect(data.userId).toBe(123456);
      expect(data.chatId).toBe(123456);
      expect(data.threadId).toBe(789);
      expect(data.topicKey).toBe("123456:789");
    } finally {
      getUpdatesSpy.mockRestore();
      answerSpy.mockRestore();
      editSpy.mockRestore();
    }
  });

  test("filters unauthorized users for callback queries", async () => {
    const cortex = makeMockCortex();
    let answerCalled = false;
    let editCalled = false;

    const mockUpdate: telegramApi.TelegramUpdate = {
      update_id: 850,
      callback_query: {
        id: "callback-unauth-unique",
        from: { id: 999999 }, // Not in allowedUserIds
        message: {
          message_id: 450,
          chat: { id: 999999 },
        },
        data: "unauthorized-data",
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

    const answerSpy = spyOn(
      telegramApi,
      "answerCallbackQuery",
    ).mockImplementation(async () => {
      answerCalled = true;
      return true;
    });

    const editSpy = spyOn(
      telegramApi,
      "editMessageReplyMarkup",
    ).mockImplementation(async () => {
      editCalled = true;
      return true;
    });

    try {
      const channel = new TelegramChannel(cortex, DEFAULT_CONFIG);
      await channel.start();
      await new Promise((r) => setTimeout(r, 150));
      await channel.stop();

      // answerCallbackQuery should still be called (to dismiss loading)
      expect(answerCalled).toBe(true);
      // editMessageReplyMarkup should still be called (to remove buttons)
      expect(editCalled).toBe(true);
      // But cortex receive should NOT be called for unauthorized users
      expect(cortex.receiveCalls.length).toBe(0);
    } finally {
      getUpdatesSpy.mockRestore();
      answerSpy.mockRestore();
      editSpy.mockRestore();
    }
  });
});

// --- Button Transformation Tests ---
// These tests verify that buttons in outbox messages are correctly
// transformed to Telegram's inline_keyboard format.

describe("TelegramChannel button delivery", () => {
  test("buttons array transforms to inline_keyboard correctly", async () => {
    const cortex = makeMockCortex();
    let receivedReplyMarkup: telegramApi.InlineKeyboardMarkup | undefined;

    // Add a message with buttons to the outbox
    cortex.pendingMessages.push({
      messageId: "msg-with-buttons",
      topicKey: "123456:789",
      text: "Do you approve?",
      leaseToken: "lease-1",
      payload: {
        buttons: [
          { label: "Approve", data: "approve:req-1" },
          { label: "Reject", data: "reject:req-1" },
        ],
      },
    });

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        _chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        receivedReplyMarkup = opts?.replyMarkup;
        return {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456 },
          text: "Do you approve?",
        };
      },
    );

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, {
        ...DEFAULT_CONFIG,
        pollIntervalMs: 10,
      });
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();

      // Verify sendMessage was called with correct reply_markup
      expect(receivedReplyMarkup).toEqual({
        inline_keyboard: [
          [
            { text: "Approve", callback_data: "approve:req-1" },
            { text: "Reject", callback_data: "reject:req-1" },
          ],
        ],
      });
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });

  test("messages without buttons have no reply_markup", async () => {
    const cortex = makeMockCortex();
    let receivedReplyMarkup: telegramApi.InlineKeyboardMarkup | undefined =
      undefined;
    let sendMessageCalled = false;

    // Add a message without buttons
    cortex.pendingMessages.push({
      messageId: "msg-no-buttons",
      topicKey: "123456",
      text: "Simple message",
      leaseToken: "lease-2",
      payload: null,
    });

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        _chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        sendMessageCalled = true;
        receivedReplyMarkup = opts?.replyMarkup;
        return {
          message_id: 43,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456 },
          text: "Simple message",
        };
      },
    );

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, {
        ...DEFAULT_CONFIG,
        pollIntervalMs: 10,
      });
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();

      // Verify sendMessage was called without reply_markup
      expect(sendMessageCalled).toBe(true);
      expect(receivedReplyMarkup).toBeUndefined();
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });

  test("empty buttons array results in no reply_markup", async () => {
    const cortex = makeMockCortex();
    let receivedReplyMarkup: telegramApi.InlineKeyboardMarkup | undefined =
      undefined;
    let sendMessageCalled = false;

    // Add a message with empty buttons array
    cortex.pendingMessages.push({
      messageId: "msg-empty-buttons",
      topicKey: "123456",
      text: "Message with empty buttons",
      leaseToken: "lease-3",
      payload: {
        buttons: [],
      },
    });

    const sendMessageSpy = spyOn(telegramApi, "sendMessage").mockImplementation(
      async (
        _token,
        _chatId,
        _text,
        opts,
      ): Promise<telegramApi.TelegramMessage> => {
        sendMessageCalled = true;
        receivedReplyMarkup = opts?.replyMarkup;
        return {
          message_id: 44,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456 },
          text: "Message with empty buttons",
        };
      },
    );

    const getUpdatesSpy = spyOn(telegramApi, "getUpdates").mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    );

    try {
      const channel = new TelegramChannel(cortex, {
        ...DEFAULT_CONFIG,
        pollIntervalMs: 10,
      });
      await channel.start();
      await new Promise((r) => setTimeout(r, 200));
      await channel.stop();

      // Verify sendMessage was called without reply_markup (empty array = no markup)
      expect(sendMessageCalled).toBe(true);
      expect(receivedReplyMarkup).toBeUndefined();
    } finally {
      sendMessageSpy.mockRestore();
      getUpdatesSpy.mockRestore();
    }
  });
});
