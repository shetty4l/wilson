import { createLogsCommand } from "@shetty4l/core/cli";
import {
  getLogSources,
  getService,
  UPDATER_LOG,
  WILSON_CONFIG,
} from "./services";

/**
 * Wilson logs command — takes a <source> argument (service name or "updater")
 * and delegates to createLogsCommand from core for the actual file tailing.
 */
export async function cmdLogs(args: string[], json: boolean): Promise<number> {
  const source = args[0];

  if (!source) {
    console.error("Error: log source required");
    console.error(`Usage: wilson logs <source> [n]`);
    console.error(`Sources: ${getLogSources().join(", ")}`);
    return 1;
  }

  const remaining = args.slice(1);
  let logFile: string;

  if (source === "updater") {
    logFile = UPDATER_LOG;
  } else if (source === "wilson") {
    logFile = WILSON_CONFIG.logFiles.daemon;
  } else {
    const svcResult = getService(source);
    if (!svcResult.ok) {
      console.error(`Error: ${svcResult.error}`);
      console.error(`Sources: ${getLogSources().join(", ")}`);
      return 1;
    }
    const svc = svcResult.value;
    const daemonLog = svc.logFiles.daemon;
    if (!daemonLog) {
      console.error(`Error: no daemon log path defined for ${svc.name}`);
      return 1;
    }
    logFile = daemonLog;
  }

  const handler = createLogsCommand({
    logFile,
    emptyMessage: `No ${source === "updater" ? "updater" : source} logs found.`,
  });

  const result = await handler(remaining, json);
  return typeof result === "number" ? result : 0;
}
