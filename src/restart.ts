import { createLogger } from "@shetty4l/core/log";
import { existsSync } from "fs";
import { getService, getServiceNames } from "./services";

const log = createLogger("wilson");

export async function cmdRestart(
  args: string[],
  json: boolean,
): Promise<number> {
  const serviceName = args[0];
  if (!serviceName) {
    console.error("Error: service name required");
    console.error("Usage: wilson restart <service>");
    console.error(`Services: ${getServiceNames().join(", ")}`);
    return 1;
  }

  const result = getService(serviceName);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    console.error(`Services: ${getServiceNames().join(", ")}`);
    return 1;
  }

  const svc = result.value;

  if (!existsSync(svc.cliPath)) {
    if (json) {
      console.log(
        JSON.stringify({
          service: svc.name,
          error: "CLI not found",
          cliPath: svc.cliPath,
        }),
      );
    } else {
      console.error(
        `Error: ${svc.displayName} CLI not found at ${svc.cliPath}`,
      );
    }
    return 1;
  }

  if (!json) {
    console.log(`Restarting ${svc.displayName}...`);
  }

  const proc = Bun.spawn([svc.cliPath, "restart"], {
    stdout: json ? "pipe" : "inherit",
    stderr: json ? "pipe" : "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    log(`${svc.name} restarted successfully`);
  } else {
    log(`${svc.name} restart failed (exit code ${exitCode})`);
  }

  if (json) {
    const output: Record<string, unknown> = {
      service: svc.name,
      restarted: exitCode === 0,
      exitCode,
    };
    if (exitCode !== 0 && proc.stderr) {
      const stderrText = await new Response(proc.stderr).text();
      if (stderrText.trim()) output.error = stderrText.trim();
    }
    console.log(JSON.stringify(output));
  }

  return exitCode;
}
