#!/usr/bin/env bun

import {
  createDaemonCommands,
  createHealthCommand,
  createLogsCommand,
  runCli,
} from "@shetty4l/core/cli";
import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { join } from "path";
import { cmdServe } from "./serve";
import { VERSION } from "./version";

const HELP = `
Wilson CLI — organism daemon management

Usage:
  wilson serve          Start the Wilson daemon (foreground)
  wilson start          Start the Wilson daemon (background)
  wilson stop           Stop the Wilson daemon
  wilson status         Show Wilson daemon status
  wilson restart        Restart the Wilson daemon
  wilson health         Check Wilson health endpoint
  wilson logs [n]       Show last n Wilson daemon log lines (default: 20)
  wilson version        Show version

Options:
  --json                Machine-readable JSON output
  --version, -v         Show version
  --help, -h            Show help

Orchestration commands (all services) are in wilson-ctl.
`;

const CONFIG_DIR = getConfigDir("wilson");
const LOG_FILE = join(CONFIG_DIR, "wilson.log");

function getDaemon() {
  return createDaemonManager({
    name: "wilson",
    configDir: CONFIG_DIR,
    cliPath: import.meta.path,
    serveCommand: "serve",
    healthUrl: "http://localhost:7748/health",
  });
}

const daemonCmds = createDaemonCommands({
  name: "wilson",
  getDaemon,
});

const cmdHealth = createHealthCommand({
  name: "wilson",
  getHealthUrl: () => "http://localhost:7748/health",
});

const cmdLogs = createLogsCommand({
  logFile: LOG_FILE,
  emptyMessage: "No Wilson daemon logs found.",
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
      status: daemonCmds.status,
      restart: daemonCmds.restart,
      health: cmdHealth,
      logs: cmdLogs,
    },
  });
}
