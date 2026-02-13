import { existsSync } from "fs";
import { getLogSources, getService, WILSON_CONFIG } from "./services";

function readLastLines(filePath: string, count: number): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const result = Bun.spawnSync({
    cmd: ["tail", "-n", String(count), filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  const output = new TextDecoder().decode(result.stdout).trimEnd();
  if (output.length === 0) {
    return [];
  }

  return output.split("\n");
}

export function cmdLogs(args: string[], json: boolean): void {
  const source = args[0];
  const count = args[1] ? Number.parseInt(args[1], 10) : 20;

  if (!source) {
    console.error("Error: log source required");
    console.error(`Usage: wilson logs <source> [n]`);
    console.error(`Sources: ${getLogSources().join(", ")}`);
    process.exit(1);
  }

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    process.exit(1);
  }

  // "updater" is a special source — shows the wilson update log
  if (source === "updater") {
    const logPath = WILSON_CONFIG.logFiles.updater;
    const lines = readLastLines(logPath, count);

    if (json) {
      console.log(JSON.stringify({ source, path: logPath, lines }));
      return;
    }

    if (lines.length === 0) {
      console.log(`No updater logs found at ${logPath}`);
      return;
    }

    console.log(`\n=== updater (${logPath}) ===\n`);
    for (const line of lines) {
      console.log(line);
    }
    console.log();
    return;
  }

  // Service daemon log
  const svc = getService(source);
  if (!svc) {
    console.error(`Error: unknown source "${source}"`);
    console.error(`Sources: ${getLogSources().join(", ")}`);
    process.exit(1);
  }

  const logPath = svc.logFiles.daemon;
  if (!logPath) {
    console.error(`Error: no daemon log path defined for ${svc.name}`);
    process.exit(1);
  }

  const lines = readLastLines(logPath, count);

  if (json) {
    console.log(JSON.stringify({ source: svc.name, path: logPath, lines }));
    return;
  }

  if (lines.length === 0) {
    console.log(`No logs found at ${logPath}`);
    return;
  }

  console.log(`\n=== ${svc.name} (${logPath}) ===\n`);
  for (const line of lines) {
    console.log(line);
  }
  console.log();
}
