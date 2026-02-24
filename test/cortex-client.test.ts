import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CortexClient } from "../src/channels/cortex-client";

/**
 * CortexClient tests use a local Bun HTTP server to mock cortex.
 */

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let lastRequest: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
} | null = null;

// Track what the mock should respond with
let mockStatus = 202;
let mockBody: unknown = { eventId: "evt-1", status: "queued" };

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });

      let body: unknown = null;
      if (req.method === "POST") {
        body = await req.json().catch(() => null);
      }

      lastRequest = {
        method: req.method,
        url: url.pathname + url.search,
        headers,
        body,
      };

      // Auth check
      if (headers.authorization !== "Bearer test-api-key") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        });
      }

      return new Response(JSON.stringify(mockBody), {
        status: mockStatus,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function resetMock() {
  lastRequest = null;
  mockStatus = 202;
  mockBody = { eventId: "evt-1", status: "queued" };
}

describe("CortexClient.receive", () => {
  test("sends correct payload with Bearer auth", async () => {
    resetMock();
    const client = new CortexClient(baseUrl, "test-api-key");

    await client.receive({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: { events: [], windowDays: 14 },
      occurredAt: "2026-02-22T12:00:00Z",
    });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.method).toBe("POST");
    expect(lastRequest!.url).toBe("/receive");
    expect(lastRequest!.headers.authorization).toBe("Bearer test-api-key");
    expect(lastRequest!.headers["content-type"]).toBe("application/json");
    expect(lastRequest!.body).toEqual({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: { events: [], windowDays: 14 },
      occurredAt: "2026-02-22T12:00:00Z",
    });
  });

  test("returns Ok on 202 response", async () => {
    resetMock();
    mockStatus = 202;
    mockBody = { eventId: "evt-1", status: "queued" };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.receive({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: { events: [] },
      occurredAt: "2026-02-22T12:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.eventId).toBe("evt-1");
    expect(result.value.status).toBe("queued");
  });

  test("returns Ok on 200 duplicate response", async () => {
    resetMock();
    mockStatus = 200;
    mockBody = { eventId: "evt-1", status: "duplicate_ignored" };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.receive({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: { events: [] },
      occurredAt: "2026-02-22T12:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.status).toBe("duplicate_ignored");
  });

  test("returns Err on 401 response", async () => {
    resetMock();
    const client = new CortexClient(baseUrl, "wrong-key");
    const result = await client.receive({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: { events: [] },
      occurredAt: "2026-02-22T12:00:00Z",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error).toContain("401");
  });

  test("returns Err on network error", async () => {
    resetMock();
    const client = new CortexClient("http://localhost:1", "test-api-key");
    const result = await client.receive({
      channel: "calendar",
      externalId: "cal-sync-123",
      data: {},
      occurredAt: "2026-02-22T12:00:00Z",
    });

    expect(result.ok).toBe(false);
  });
});

describe("CortexClient.pollOutbox", () => {
  test("sends POST to /outbox/poll with JSON body", async () => {
    resetMock();
    mockStatus = 200;
    mockBody = { messages: [] };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.pollOutbox("telegram", {
      max: 5,
      leaseSeconds: 30,
    });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.method).toBe("POST");
    expect(lastRequest!.url).toBe("/outbox/poll");
    expect(lastRequest!.body).toEqual({
      channel: "telegram",
      max: 5,
      leaseSeconds: 30,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("includes topicKey in body when provided", async () => {
    resetMock();
    mockStatus = 200;
    mockBody = { messages: [] };

    const client = new CortexClient(baseUrl, "test-api-key");
    await client.pollOutbox("telegram", { topicKey: "user:123" });

    expect(lastRequest!.body).toEqual({
      channel: "telegram",
      topicKey: "user:123",
    });
  });

  test("returns messages from response", async () => {
    resetMock();
    mockStatus = 200;
    mockBody = {
      messages: [
        {
          messageId: "msg-1",
          topicKey: "user:123",
          text: "Hello",
          leaseToken: "lease-abc",
          payload: null,
        },
      ],
    };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.pollOutbox("telegram");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].messageId).toBe("msg-1");
      expect(result.value[0].text).toBe("Hello");
    }
  });
});

describe("CortexClient.ackOutbox", () => {
  test("sends POST to /outbox/ack with messageId and leaseToken", async () => {
    resetMock();
    mockStatus = 200;
    mockBody = { ok: true, status: "delivered" };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.ackOutbox("msg-123", "lease-abc");

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.method).toBe("POST");
    expect(lastRequest!.url).toBe("/outbox/ack");
    expect(lastRequest!.body).toEqual({
      messageId: "msg-123",
      leaseToken: "lease-abc",
    });
    expect(result.ok).toBe(true);
  });

  test("returns Err on 404 (not found)", async () => {
    resetMock();
    mockStatus = 404;
    mockBody = { error: "not_found" };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.ackOutbox("msg-unknown", "lease-abc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });

  test("returns Err on 409 (lease conflict)", async () => {
    resetMock();
    mockStatus = 409;
    mockBody = { error: "lease_conflict" };

    const client = new CortexClient(baseUrl, "test-api-key");
    const result = await client.ackOutbox("msg-123", "wrong-lease");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("409");
    }
  });
});
