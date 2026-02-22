import { createServer, type HttpServer } from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { onShutdown } from "@shetty4l/core/signals";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { handleApiRequest } from "./api";
import { CalendarChannel } from "./channels/calendar/index";
import { CortexClient } from "./channels/cortex-client";
import { ChannelRegistry } from "./channels/index";
import { loadConfig } from "./config";
import { VERSION } from "./version";

// Dashboard static files location (relative to project root)
const DASHBOARD_DIR = join(import.meta.dir, "..", "dashboard", "build");

const log = createLogger("wilson");

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serve static files from the dashboard dist directory.
 * Maps /dashboard/* paths to files in dashboard/dist/.
 */
function serveDashboardFile(pathname: string): Response | null {
  // Remove /dashboard prefix
  const filePath = pathname.replace(/^\/dashboard/, "") || "/";

  // Resolve full path (strip leading slash for join, default to "." for root)
  let fullPath = join(DASHBOARD_DIR, filePath.slice(1) || ".");

  // Security: ensure path is within DASHBOARD_DIR
  if (!fullPath.startsWith(DASHBOARD_DIR)) {
    return null;
  }

  // Check if path exists
  if (!existsSync(fullPath)) {
    return null;
  }

  // If path is a directory, serve index.html from it
  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    fullPath = join(fullPath, "index.html");
    if (!existsSync(fullPath)) {
      return null;
    }
  }

  // Determine MIME type from resolved path
  const ext = fullPath.substring(fullPath.lastIndexOf("."));
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Read and return file
  const file = Bun.file(fullPath);
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache", // For development; could be longer for production
    },
  });
}

/**
 * Start the Wilson daemon server.
 *
 * Returns void (no exit code) so runCli keeps the process alive.
 * Graceful shutdown is handled via onShutdown.
 *
 * Startup order:  server -> channels.startAll()
 * Shutdown order: channels.stopAll() -> server.stop()
 */
export async function cmdServe(): Promise<void> {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`wilson: config error: ${configResult.error}`);
    process.exit(1);
  }

  const config = configResult.value;

  // --- HTTP server ---
  const server: HttpServer = createServer({
    name: "wilson",
    port: config.port,
    host: config.host,
    version: VERSION,
    onRequest: async (req: Request) => {
      const url = new URL(req.url);

      // GET / redirects to /dashboard/
      if (url.pathname === "/") {
        return Response.redirect(new URL("/dashboard/", url.origin), 302);
      }

      // Handle /api/* routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRequest(req, url, config);
      }

      // Serve dashboard static files for /dashboard/*
      if (url.pathname.startsWith("/dashboard")) {
        return serveDashboardFile(url.pathname);
      }

      // Return null for other paths (404)
      return null;
    },
  });

  log(`server started on ${config.host}:${server.port} (v${VERSION})`);

  // --- Channels ---
  const cortex = new CortexClient(config.cortex.url, config.cortex.apiKey);
  const registry = new ChannelRegistry();

  if (config.channels.calendar.enabled) {
    const calendar = new CalendarChannel(cortex, {
      pollIntervalSeconds: config.channels.calendar.pollIntervalSeconds,
      lookAheadDays: config.channels.calendar.lookAheadDays,
      extendedLookAheadDays: config.channels.calendar.extendedLookAheadDays,
    });
    registry.register(calendar);
  }

  await registry.startAll();

  // --- Shutdown ---
  onShutdown(
    async () => {
      log("shutting down...");
      await registry.stopAll();
      server.stop();
      log("stopped");
    },
    { name: "wilson", timeoutMs: 10_000 },
  );
}
