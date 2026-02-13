import { join } from "path";
import { getService, getServiceNames } from "./services";

export async function cmdUpdate(args: string[], json: boolean): Promise<void> {
  const serviceName = args[0];

  // Resolve the update script path relative to this repo
  const wilsonRoot = join(import.meta.dir, "..");
  const updateScript = join(wilsonRoot, "deploy", "wilson-update.sh");

  if (serviceName) {
    // Validate service name
    if (serviceName !== "self" && !getService(serviceName)) {
      console.error(`Error: unknown service "${serviceName}"`);
      console.error(`Services: ${getServiceNames().join(", ")}, self`);
      process.exit(1);
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

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
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

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
