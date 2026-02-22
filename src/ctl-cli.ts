#!/usr/bin/env bun

import { runCli } from "@shetty4l/core/cli";
import { cmdHealth } from "./health";
import { cmdLogs } from "./logs";
import { cmdRestart } from "./restart";
import { getServiceNames } from "./services";
import { cmdStatus } from "./status";
import { cmdSupervise } from "./supervise";
import { cmdUpdate } from "./update";
import { VERSION } from "./version";

const HELP = `
Wilson CTL — orchestration across all services

Usage:
  wilson-ctl status               Show all services (running/stopped, PID, port, version)
  wilson-ctl health               Check health endpoints for all services
  wilson-ctl logs <source> [n]    Show last n log lines (default: 20)
  wilson-ctl restart <service>    Restart a managed service via its CLI
  wilson-ctl update [service]     Run update check (all or specific service)
  wilson-ctl supervise            Run supervisor (long-lived, manages all services)
  wilson-ctl version              Show version

Services: ${getServiceNames().join(", ")}
Log sources: ${getServiceNames().join(", ")}, supervisor

Options:
  --json                Machine-readable JSON output
  --version, -v         Show version
  --help, -h            Show help
`;

// Only run when executed directly, not when imported by tests
const isDirectRun =
  import.meta.path === Bun.main || process.argv[1]?.endsWith("ctl-cli.ts");
if (isDirectRun) {
  runCli({
    name: "wilson-ctl",
    version: VERSION,
    help: HELP,
    commands: {
      status: (_args, json) => cmdStatus(json),
      health: (_args, json) => cmdHealth(json),
      logs: cmdLogs,
      restart: cmdRestart,
      update: cmdUpdate,
      supervise: cmdSupervise,
    },
  });
}
