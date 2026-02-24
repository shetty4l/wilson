import type { ChannelRegistry, ChannelTool } from "../channels";

interface ToolWithChannel {
  channel: string;
  tool: ChannelTool;
}

interface GetToolsResponse {
  tools: ToolWithChannel[];
}

interface ExecuteToolRequest {
  channel: string;
  tool: string;
  params?: Record<string, unknown>;
}

/**
 * Handle GET /api/tools - returns all tools from all channels.
 */
export function handleGetTools(registry: ChannelRegistry): Response {
  const tools = registry.getAllTools();
  const response: GetToolsResponse = { tools };
  return Response.json(response);
}

/**
 * Handle POST /api/tools/execute - execute a tool on a specific channel.
 */
export async function handleExecuteTool(
  req: Request,
  registry: ChannelRegistry,
): Promise<Response> {
  let body: ExecuteToolRequest;

  try {
    body = (await req.json()) as ExecuteToolRequest;
  } catch {
    return Response.json(
      { success: false, error: "invalid request body" },
      { status: 400 },
    );
  }

  const { channel, tool, params } = body;

  if (!channel || typeof channel !== "string") {
    return Response.json(
      { success: false, error: "channel name required" },
      { status: 400 },
    );
  }

  if (!tool || typeof tool !== "string") {
    return Response.json(
      { success: false, error: "tool name required" },
      { status: 400 },
    );
  }

  const result = await registry.executeTool(channel, tool, params);

  if (!result.ok) {
    // Determine status code based on error type
    const errorMsg = result.error;
    if (errorMsg.includes("not found")) {
      return Response.json(
        { success: false, error: errorMsg },
        { status: 404 },
      );
    }
    if (
      errorMsg.includes("has no tools") ||
      errorMsg.includes("does not implement")
    ) {
      return Response.json(
        { success: false, error: errorMsg },
        { status: 400 },
      );
    }
    return Response.json({ success: false, error: errorMsg }, { status: 500 });
  }

  return Response.json(result.value);
}
