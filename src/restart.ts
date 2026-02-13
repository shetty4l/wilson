import { existsSync } from "fs";
import { getService, getServiceNames } from "./services";

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

  const svc = getService(serviceName);
  if (!svc) {
    console.error(`Error: unknown service "${serviceName}"`);
    console.error(`Services: ${getServiceNames().join(", ")}`);
    return 1;
  }

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

  if (json) {
    console.log(
      JSON.stringify({
        service: svc.name,
        restarted: exitCode === 0,
        exitCode,
      }),
    );
  }

  return exitCode;
}
