import { describe, expect, test } from "bun:test";
import { handleExecuteTool, handleGetTools } from "../src/api/tools";
import {
  type Channel,
  ChannelRegistry,
  type ChannelStats,
  type ChannelTool,
  type ToolResult,
} from "../src/channels/index";

// --- Test Helpers ---

function makeBaseChannel(name: string): Channel {
  return {
    name,
    canReceive: true,
    canDeliver: false,
    mode: "buffered" as const,
    priority: 2,
    async start() {},
    async stop() {},
    async sync() {},
    getStats(): ChannelStats {
      return {
        lastSyncAt: null,
        lastPostAt: null,
        eventsPosted: 0,
        status: "healthy",
        error: null,
        consecutiveFailures: 0,
      };
    },
  };
}

function makeChannelWithTools(
  name: string,
  tools: ChannelTool[],
  executeFn?: (
    toolName: string,
    params?: Record<string, unknown>,
  ) => Promise<ToolResult>,
): Channel {
  return {
    ...makeBaseChannel(name),
    tools,
    executeTool: executeFn,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/tools/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- ChannelRegistry Tool Tests ---

describe("ChannelRegistry tools", () => {
  test("getAllTools returns empty array when no channels have tools", () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("alpha"));
    reg.register(makeBaseChannel("beta"));

    const tools = reg.getAllTools();
    expect(tools).toEqual([]);
  });

  test("getAllTools aggregates tools from multiple channels", () => {
    const reg = new ChannelRegistry();

    const tool1: ChannelTool = { name: "sync", description: "Sync events" };
    const tool2: ChannelTool = {
      name: "create",
      description: "Create event",
      parameters: { type: "object" },
    };
    const tool3: ChannelTool = { name: "send", description: "Send message" };

    reg.register(
      makeChannelWithTools("calendar", [tool1, tool2], async () => ({
        success: true,
      })),
    );
    reg.register(makeBaseChannel("email")); // no tools
    reg.register(
      makeChannelWithTools("telegram", [tool3], async () => ({
        success: true,
      })),
    );

    const tools = reg.getAllTools();
    expect(tools).toHaveLength(3);
    expect(tools).toEqual([
      { channel: "calendar", tool: tool1 },
      { channel: "calendar", tool: tool2 },
      { channel: "telegram", tool: tool3 },
    ]);
  });

  test("executeTool returns error for unknown channel", async () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("calendar"));

    const result = await reg.executeTool("unknown", "sync");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('channel "unknown" not found');
    }
  });

  test("executeTool returns error for channel without tools", async () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("calendar"));

    const result = await reg.executeTool("calendar", "sync");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('channel "calendar" has no tools');
    }
  });

  test("executeTool returns error for unknown tool on channel", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async () => ({ success: true })),
    );

    const result = await reg.executeTool("calendar", "unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'tool "unknown" not found on channel "calendar"',
      );
    }
  });

  test("executeTool returns error when channel has tools but no executeTool method", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    // Channel has tools array but no executeTool method
    const channel = makeChannelWithTools("calendar", [tool], undefined);
    reg.register(channel);

    const result = await reg.executeTool("calendar", "sync");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'channel "calendar" does not implement executeTool',
      );
    }
  });

  test("executeTool returns success result", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async (_name, params) => ({
        success: true,
        data: { synced: 5, params },
      })),
    );

    const result = await reg.executeTool("calendar", "sync", { days: 7 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        success: true,
        data: { synced: 5, params: { days: 7 } },
      });
    }
  });

  test("executeTool catches and wraps thrown errors", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async () => {
        throw new Error("Calendar API unavailable");
      }),
    );

    const result = await reg.executeTool("calendar", "sync");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        success: false,
        error: "Calendar API unavailable",
      });
    }
  });
});

// --- API Handler Tests ---

describe("handleGetTools", () => {
  test("returns empty tools array when no channels have tools", async () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("calendar"));

    const response = handleGetTools(reg);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ tools: [] });
  });

  test("returns tools from all channels", async () => {
    const reg = new ChannelRegistry();
    const tool1: ChannelTool = { name: "sync", description: "Sync events" };
    const tool2: ChannelTool = { name: "send", description: "Send message" };

    reg.register(
      makeChannelWithTools("calendar", [tool1], async () => ({
        success: true,
      })),
    );
    reg.register(
      makeChannelWithTools("telegram", [tool2], async () => ({
        success: true,
      })),
    );

    const response = handleGetTools(reg);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      tools: [
        { channel: "calendar", tool: tool1 },
        { channel: "telegram", tool: tool2 },
      ],
    });
  });
});

describe("handleExecuteTool", () => {
  test("returns 400 for invalid JSON body", async () => {
    const reg = new ChannelRegistry();
    const request = new Request("http://localhost/api/tools/execute", {
      method: "POST",
      body: "not json",
    });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ success: false, error: "invalid request body" });
  });

  test("returns 400 when channel is missing", async () => {
    const reg = new ChannelRegistry();
    const request = makeRequest({ tool: "sync" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ success: false, error: "channel name required" });
  });

  test("returns 400 when tool is missing", async () => {
    const reg = new ChannelRegistry();
    const request = makeRequest({ channel: "calendar" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ success: false, error: "tool name required" });
  });

  test("returns 404 for unknown channel", async () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("calendar"));
    const request = makeRequest({ channel: "unknown", tool: "sync" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      success: false,
      error: 'channel "unknown" not found',
    });
  });

  test("returns 404 for unknown tool on channel", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async () => ({ success: true })),
    );
    const request = makeRequest({ channel: "calendar", tool: "unknown" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      success: false,
      error: 'tool "unknown" not found on channel "calendar"',
    });
  });

  test("returns 400 for channel without tools", async () => {
    const reg = new ChannelRegistry();
    reg.register(makeBaseChannel("calendar"));
    const request = makeRequest({ channel: "calendar", tool: "sync" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      success: false,
      error: 'channel "calendar" has no tools',
    });
  });

  test("returns 400 for channel without executeTool method", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(makeChannelWithTools("calendar", [tool], undefined));
    const request = makeRequest({ channel: "calendar", tool: "sync" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      success: false,
      error: 'channel "calendar" does not implement executeTool',
    });
  });

  test("returns result on successful execution", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async (_name, params) => ({
        success: true,
        data: { synced: 10, params },
      })),
    );
    const request = makeRequest({
      channel: "calendar",
      tool: "sync",
      params: { days: 30 },
    });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { synced: 10, params: { days: 30 } },
    });
  });

  test("returns error result when tool execution fails", async () => {
    const reg = new ChannelRegistry();
    const tool: ChannelTool = { name: "sync", description: "Sync events" };
    reg.register(
      makeChannelWithTools("calendar", [tool], async () => {
        throw new Error("API rate limited");
      }),
    );
    const request = makeRequest({ channel: "calendar", tool: "sync" });

    const response = await handleExecuteTool(request, reg);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ success: false, error: "API rate limited" });
  });
});
