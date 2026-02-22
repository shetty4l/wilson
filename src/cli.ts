#!/usr/bin/env bun

import { createDaemonCommands, runCli } from "@shetty4l/core/cli";
import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { cmdHealth } from "./health";
import { cmdLogs } from "./logs";
import { cmdRestart } from "./restart";
import { cmdServe } from "./serve";
import { getServiceNames } from "./services";
import { cmdStatus } from "./status";
import { cmdUpdate } from "./update";
import { VERSION } from "./version";

const HELP = `
Wilson CLI — deployment orchestration + organism daemon

Usage:
  wilson serve                Start the Wilson daemon (foreground)
  wilson start                Start the Wilson daemon (background)
  wilson stop                 Stop the Wilson daemon
  wilson daemon-status        Show Wilson daemon status
  wilson restart-daemon       Restart the Wilson daemon
  wilson status               Show all services (running/stopped, PID, port, version)
  wilson health               Check health endpoints for all services
  wilson logs <source> [n]    Show last n log lines (default: 20)
  wilson restart <service>    Restart a managed service via its CLI
  wilson update [service]     Run update check (all or specific service)

Services: ${getServiceNames().join(", ")}
Log sources: ${getServiceNames().join(", ")}, updater, wilson

Options:
  --json                      Machine-readable JSON output
  --version, -v               Show version
  --help, -h                  Show help
`;

function getDaemon() {
  return createDaemonManager({
    name: "wilson",
    configDir: getConfigDir("wilson"),
    cliPath: import.meta.path,
    serveCommand: "serve",
    healthUrl: "http://localhost:7748/health",
  });
}

const daemonCmds = createDaemonCommands({
  name: "wilson",
  getDaemon,
});

// Only run when executed directly, not when imported by tests
const isDirectRun =
  import.meta.path === Bun.main || process.argv[1]?.endsWith("cli.ts");
if (isDirectRun) {
  runCli({
    name: "wilson",
    version: VERSION,
    help: HELP,
    commands: {
      serve: cmdServe,
      start: daemonCmds.start,
      stop: daemonCmds.stop,
      "daemon-status": daemonCmds.status,
      "restart-daemon": daemonCmds.restart,
      status: (_args, json) => cmdStatus(json),
      health: (_args, json) => cmdHealth(json),
      logs: cmdLogs,
      restart: cmdRestart,
      update: cmdUpdate,
    },
  });
}
