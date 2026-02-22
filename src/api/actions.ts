import { err, ok, type Result } from "@shetty4l/core/result";
import { existsSync } from "fs";
import type { WilsonConfig } from "../config";
import { getService } from "../services";
import { checkAndUpdate, readGithubToken, type UpdateResult } from "../update";

/**
 * Handle restart action for a service.
 * Spawns the service's CLI restart command.
 */
export async function handleRestartAction(
  serviceName: string,
  config?: WilsonConfig,
): Promise<Result<void, string>> {
  const result = getService(serviceName, config);
  if (!result.ok) {
    return err(result.error);
  }

  const svc = result.value;

  if (!existsSync(svc.cliPath)) {
    return err(`CLI not found at ${svc.cliPath}`);
  }

  const proc = Bun.spawn([svc.cliPath, "restart"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return ok(undefined);
  }

  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  return err(
    `restart failed (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
  );
}

/**
 * Handle update action for a service.
 * Checks for latest version and updates if available.
 */
export async function handleUpdateAction(
  serviceName: string,
  config?: WilsonConfig,
): Promise<Result<UpdateResult, string>> {
  const result = getService(serviceName, config);
  if (!result.ok) {
    return err(result.error);
  }

  const svc = result.value;
  const token = readGithubToken();

  // Silent logger for API context
  const log = () => {};

  const updateResult = await checkAndUpdate(svc, token, log);

  if (updateResult.error) {
    return err(updateResult.error);
  }

  return ok(updateResult);
}
