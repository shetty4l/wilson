import { createServer, type HttpServer } from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { onShutdown } from "@shetty4l/core/signals";
import { loadConfig } from "./config";
import { VERSION } from "./version";

const log = createLogger("wilson");

/**
 * Start the Wilson daemon server.
 *
 * Returns void (no exit code) so runCli keeps the process alive.
 * Graceful shutdown is handled via onShutdown.
 */
export async function cmdServe(): Promise<void> {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`wilson: config error: ${configResult.error}`);
    process.exit(1);
  }

  const config = configResult.value;
  let server: HttpServer | undefined;

  server = createServer({
    name: "wilson",
    port: config.port,
    host: config.host,
    version: VERSION,
    onRequest: () => null,
  });

  onShutdown(
    () => {
      log("shutting down...");
      server?.stop();
      log("stopped");
    },
    { name: "wilson", timeoutMs: 10_000 },
  );

  log(`server started on ${config.host}:${server.port} (v${VERSION})`);
}
