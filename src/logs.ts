import { err, ok, type Result } from "@shetty4l/core/result";
import { existsSync } from "fs";
import { getLogSources, getService, WILSON_CONFIG } from "./services";

function readLastLines(
  filePath: string,
  count: number,
): Result<string[], string> {
  if (!existsSync(filePath)) {
    return err(`log file not found: ${filePath}`);
  }

  const proc = Bun.spawnSync({
    cmd: ["tail", "-n", String(count), filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    return err(`failed to read log file: ${filePath}`);
  }

  const output = new TextDecoder().decode(proc.stdout).trimEnd();
  if (output.length === 0) {
    return ok([]);
  }

  return ok(output.split("\n"));
}

export function cmdLogs(args: string[], json: boolean): number {
  const source = args[0];
  const count = args[1] ? Number.parseInt(args[1], 10) : 20;

  if (!source) {
    console.error("Error: log source required");
    console.error(`Usage: wilson logs <source> [n]`);
    console.error(`Sources: ${getLogSources().join(", ")}`);
    return 1;
  }

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    return 1;
  }

  // "updater" is a special source — shows the wilson update log
  if (source === "updater") {
    const logPath = WILSON_CONFIG.logFiles.updater;
    const result = readLastLines(logPath, count);

    if (!result.ok) {
      if (json) {
        console.log(JSON.stringify({ source, path: logPath, lines: [] }));
        return 0;
      }
      console.log(`No updater logs found at ${logPath}`);
      return 0;
    }

    const lines = result.value;

    if (json) {
      console.log(JSON.stringify({ source, path: logPath, lines }));
      return 0;
    }

    if (lines.length === 0) {
      console.log(`No updater logs found at ${logPath}`);
      return 0;
    }

    console.log(`\n=== updater (${logPath}) ===\n`);
    for (const line of lines) {
      console.log(line);
    }
    console.log();
    return 0;
  }

  // Service daemon log
  const svcResult = getService(source);
  if (!svcResult.ok) {
    console.error(`Error: ${svcResult.error}`);
    console.error(`Sources: ${getLogSources().join(", ")}`);
    return 1;
  }

  const svc = svcResult.value;
  const logPath = svc.logFiles.daemon;
  if (!logPath) {
    console.error(`Error: no daemon log path defined for ${svc.name}`);
    return 1;
  }

  const result = readLastLines(logPath, count);

  if (!result.ok) {
    if (json) {
      console.log(
        JSON.stringify({ source: svc.name, path: logPath, lines: [] }),
      );
      return 0;
    }
    console.log(`No logs found at ${logPath}`);
    return 0;
  }

  const lines = result.value;

  if (json) {
    console.log(JSON.stringify({ source: svc.name, path: logPath, lines }));
    return 0;
  }

  if (lines.length === 0) {
    console.log(`No logs found at ${logPath}`);
    return 0;
  }

  console.log(`\n=== ${svc.name} (${logPath}) ===\n`);
  for (const line of lines) {
    console.log(line);
  }
  console.log();
  return 0;
}
