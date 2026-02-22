import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Allowed services for log streaming.
 * Security: Only these service names are allowed to prevent path traversal.
 */
const ALLOWED_SERVICES = ["engram", "synapse", "cortex", "wilson"] as const;
type AllowedService = (typeof ALLOWED_SERVICES)[number];

/**
 * Check if a service name is allowed.
 */
export function isAllowedService(service: string): service is AllowedService {
  return ALLOWED_SERVICES.includes(service as AllowedService);
}

/**
 * Get the log file path for a service.
 * Security: Constructs path safely without allowing user input to influence path structure.
 */
function getLogPath(service: AllowedService): string {
  return join(homedir(), ".config", service, `${service}.log`);
}

/**
 * Read the last N lines from a file.
 */
function readLastLines(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Handle the log stream SSE endpoint.
 * Streams log file content as Server-Sent Events.
 */
export function handleLogsStream(service: string): Response {
  // Security: Validate service name against allowed list
  if (!isAllowedService(service)) {
    return Response.json(
      {
        error: `Invalid service: ${service}. Allowed: ${ALLOWED_SERVICES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const logPath = getLogPath(service);
  const INITIAL_LINES = 100;
  const encoder = new TextEncoder();

  // Track file position for incremental reading
  let lastSize = 0;
  let lastContent = "";

  // Store intervals in closure for cleanup (not on controller)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(
          `event: connected\ndata: ${JSON.stringify({ service, path: logPath })}\n\n`,
        ),
      );

      // Check if file exists
      if (!existsSync(logPath)) {
        controller.enqueue(
          encoder.encode(
            `event: info\ndata: ${JSON.stringify({ message: "Log file not found. Waiting for logs..." })}\n\n`,
          ),
        );
        lastSize = 0;
        lastContent = "";
      } else {
        // Send initial lines
        const initialLines = readLastLines(logPath, INITIAL_LINES);
        for (const line of initialLines) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }

        // Track initial state
        try {
          lastContent = readFileSync(logPath, "utf-8");
          lastSize = lastContent.length;
        } catch {
          lastSize = 0;
          lastContent = "";
        }
      }

      // Watch file for changes
      pollInterval = setInterval(() => {
        try {
          if (!existsSync(logPath)) {
            // File was deleted or doesn't exist yet
            if (lastSize > 0) {
              controller.enqueue(
                encoder.encode(
                  `event: info\ndata: ${JSON.stringify({ message: "Log file removed" })}\n\n`,
                ),
              );
              lastSize = 0;
              lastContent = "";
            }
            return;
          }

          const currentContent = readFileSync(logPath, "utf-8");
          const currentSize = currentContent.length;

          if (currentSize > lastSize) {
            // File grew - send new content
            const newContent = currentContent.slice(lastSize);
            const newLines = newContent
              .split("\n")
              .filter((line) => line.length > 0);

            for (const line of newLines) {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            }

            lastSize = currentSize;
            lastContent = currentContent;
          } else if (currentSize < lastSize) {
            // File was truncated/rotated - re-read from start
            controller.enqueue(
              encoder.encode(
                `event: info\ndata: ${JSON.stringify({ message: "Log file rotated" })}\n\n`,
              ),
            );

            const lines = currentContent
              .split("\n")
              .filter((line) => line.length > 0);
            for (const line of lines) {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            }

            lastSize = currentSize;
            lastContent = currentContent;
          }
        } catch {
          // Ignore read errors (file might be being written to)
        }
      }, 1000); // Poll every second

      // Heartbeat to keep connection alive (5s to stay well under idle timeouts)
      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // Stream might be closed
        }
      }, 5000); // Heartbeat every 5 seconds
    },

    cancel() {
      // Cleanup on client disconnect - use closure variables
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering if behind proxy
    },
  });
}

export { ALLOWED_SERVICES };
