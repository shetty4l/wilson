/**
 * Supervisor — long-running process that ensures all services are healthy
 * and up-to-date. Runs as `wilson-ctl supervise`.
 *
 * Behavior:
 * 1. On start: ensure all 4 services running in dependency order
 * 2. Health check loop (~30s): restart unhealthy services
 * 3. Update check loop (~60s, round-robin): one service per tick
 * 4. On SIGTERM: stop all services in reverse order, exit cleanly
 */

import { createLogger } from "@shetty4l/core/log";
import { onShutdown } from "@shetty4l/core/signals";
import { fetchHealth } from "./health";
import { SERVICES } from "./services";
import { checkAndUpdate, readGithubToken, restartService } from "./update";

const log = createLogger("wilson:supervisor");

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

// --- Ensure services running ---

export async function ensureServicesRunning(): Promise<void> {
  for (const svc of SERVICES) {
    const result = await fetchHealth(svc.healthUrl);
    if (result.ok && result.value.status === "healthy") {
      log(`${svc.name}: already running`);
      continue;
    }

    log(`${svc.name}: not healthy, starting...`);
    try {
      const proc = Bun.spawn([svc.cliPath, "start"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        log(`${svc.name}: started successfully`);
      } else {
        const stderr = proc.stderr
          ? await new Response(proc.stderr).text()
          : "";
        log(
          `${svc.name}: start failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
        );
      }
    } catch (e) {
      log(
        `${svc.name}: start error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// --- Health check loop ---

export async function runHealthCheck(): Promise<void> {
  for (const svc of SERVICES) {
    const result = await fetchHealth(svc.healthUrl);
    if (result.ok && result.value.status === "healthy") {
      continue;
    }

    const reason = result.ok ? `status: ${result.value.status}` : result.error;
    log(`${svc.name}: unhealthy (${reason}), restarting...`);

    const restartResult = await restartService(svc);
    if (restartResult.ok) {
      log(`${svc.name}: restart succeeded`);
    } else {
      log(`${svc.name}: restart failed: ${restartResult.error}`);
    }
  }
}

// --- Update check loop (round-robin) ---

let currentIndex = 0;

export function resetUpdateIndex(): void {
  currentIndex = 0;
}

export async function runUpdateCheck(
  token: string | null,
): Promise<{ service: string; selfUpdateInstalled: boolean }> {
  const svc = SERVICES[currentIndex];
  currentIndex = (currentIndex + 1) % SERVICES.length;

  const result = await checkAndUpdate(svc, token, (msg) => log(msg));

  if (svc.name === "wilson" && result.updated) {
    return { service: svc.name, selfUpdateInstalled: true };
  }

  if (result.error) {
    log(`update check error for ${svc.name}: ${result.error}`);
  }

  return { service: svc.name, selfUpdateInstalled: false };
}

// --- Stop all services ---

export async function stopAllServices(): Promise<void> {
  const reversed = [...SERVICES].reverse();
  for (const svc of reversed) {
    log(`stopping ${svc.name}...`);
    try {
      const proc = Bun.spawn([svc.cliPath, "stop"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const result = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS),
        ),
      ]);

      if (result === "timeout") {
        proc.kill();
        log(`${svc.name}: stop timed out after ${STOP_TIMEOUT_MS / 1000}s`);
      } else if (result === 0) {
        log(`${svc.name}: stopped`);
      } else {
        log(`${svc.name}: stop exited with code ${result}`);
      }
    } catch (e) {
      log(
        `${svc.name}: stop error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// --- Main entry point ---

export async function cmdSupervise(
  _args: string[],
  _json: boolean,
): Promise<number> {
  log("supervisor starting...");

  const token = readGithubToken();

  // 1. Ensure all services are running
  await ensureServicesRunning();

  // 2. Start health check interval (30s)
  const healthInterval = setInterval(
    () => void runHealthCheck(),
    HEALTH_CHECK_INTERVAL_MS,
  );

  // 3. Start update check interval (60s, round-robin)
  const updateInterval = setInterval(() => {
    void runUpdateCheck(token).then((result) => {
      if (result.selfUpdateInstalled) {
        log("self-update installed, exiting for KeepAlive restart");
        clearInterval(healthInterval);
        clearInterval(updateInterval);
        process.exit(0);
      }
    });
  }, UPDATE_CHECK_INTERVAL_MS);

  // 4. Register SIGTERM handler
  onShutdown(
    async () => {
      log("shutting down...");
      clearInterval(healthInterval);
      clearInterval(updateInterval);
      await stopAllServices();
      log("supervisor shutdown complete");
    },
    { name: "supervisor", timeoutMs: 30_000 },
  );

  log("supervisor running");

  // Block forever — cleanup happens in onShutdown
  await new Promise(() => {});

  // Unreachable, but TypeScript needs a return
  return 0;
}
