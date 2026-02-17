#!/usr/bin/env bun

import { runCli } from "@shetty4l/core/cli";
import { cmdHealth } from "./health";
import { cmdLogs } from "./logs";
import { cmdRestart } from "./restart";
import { getServiceNames } from "./services";
import { cmdStatus } from "./status";
import { cmdUpdate } from "./update";
import { VERSION } from "./version";

const HELP = `
Wilson CLI — deployment orchestration

Usage:
  wilson status              Show all services (running/stopped, PID, port, version)
  wilson health              Check health endpoints for all services
  wilson logs <source> [n]   Show last n log lines (default: 20)
  wilson restart <service>   Restart a service via its CLI
  wilson update [service]    Run update check (all or specific service)

Services: ${getServiceNames().join(", ")}
Log sources: ${getServiceNames().join(", ")}, updater

Options:
  --json                     Machine-readable JSON output
  --version, -v              Show version
  --help, -h                 Show help
`;

// Only run when executed directly, not when imported by tests
const isDirectRun =
  import.meta.path === Bun.main || process.argv[1]?.endsWith("cli.ts");
if (isDirectRun) {
  runCli({
    name: "wilson",
    version: VERSION,
    help: HELP,
    commands: {
      status: (_args, json) => cmdStatus(json),
      health: (_args, json) => cmdHealth(json),
      logs: cmdLogs,
      restart: cmdRestart,
      update: cmdUpdate,
    },
  });
}
