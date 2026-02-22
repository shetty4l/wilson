import { join } from "path";
import { getService, getServiceNames } from "./services";

export async function cmdUpdate(
  args: string[],
  json: boolean,
): Promise<number> {
  const serviceName = args[0];

  // Resolve the update script path relative to this repo
  const wilsonRoot = join(import.meta.dir, "..");
  const updateScript = join(wilsonRoot, "deploy", "wilson-update.sh");

  if (serviceName) {
    // Validate service name
    const svcResult = getService(serviceName);
    if (!svcResult.ok) {
      console.error(`Error: ${svcResult.error}`);
      console.error(`Services: ${getServiceNames().join(", ")}`);
      return 1;
    }

    if (!json) {
      console.log(`Running update check for ${serviceName}...`);
    }

    const proc = Bun.spawn(["bash", updateScript, serviceName], {
      stdout: json ? "pipe" : "inherit",
      stderr: json ? "pipe" : "inherit",
      env: { ...process.env, WILSON_JSON: json ? "1" : "" },
    });

    const exitCode = await proc.exited;

    if (json) {
      const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
      console.log(
        JSON.stringify({
          service: serviceName,
          exitCode,
          output: stdout.trim(),
        }),
      );
    }

    return exitCode;
  }

  // Run full update check
  if (!json) {
    console.log("Running update check for all services...\n");
  }

  const proc = Bun.spawn(["bash", updateScript], {
    stdout: json ? "pipe" : "inherit",
    stderr: json ? "pipe" : "inherit",
    env: { ...process.env, WILSON_JSON: json ? "1" : "" },
  });

  const exitCode = await proc.exited;

  if (json) {
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    console.log(
      JSON.stringify({ service: "all", exitCode, output: stdout.trim() }),
    );
  }

  return exitCode;
}
