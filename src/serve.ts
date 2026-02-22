import { createServer, type HttpServer } from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { onShutdown } from "@shetty4l/core/signals";
import { handleApiRequest } from "./api";
import { CalendarChannel } from "./channels/calendar/index";
import { CortexClient } from "./channels/cortex-client";
import { ChannelRegistry } from "./channels/index";
import { loadConfig } from "./config";
import { VERSION } from "./version";

const log = createLogger("wilson");

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
      // Handle /api/* routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRequest(req, url, config);
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
