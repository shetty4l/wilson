#!/usr/bin/env bun

/**
 * Wilson CLI — deployment orchestration
 *
 * Usage:
 *   wilson status              Show all services (running/stopped, PID, port, version)
 *   wilson health              Check health endpoints for all services
 *   wilson logs <service> [n]  Show last n log lines (default: 20)
 *   wilson restart <service>   Restart a service
 *   wilson update [service]    Run update check (all services if omitted)
 *   wilson version             Show Wilson + all service versions
 *
 * Services: engram, synapse
 *
 * Options:
 *   --json                     Machine-readable JSON output
 *   --help, -h                 Show help
 */

import { cmdHealth } from "./health";
import { cmdLogs } from "./logs";
import { cmdRestart } from "./restart";
import { getServiceNames } from "./services";
import { cmdStatus } from "./status";
import { cmdUpdate } from "./update";
import { VERSION } from "./version";
import { cmdVersion } from "./versioncmd";

const HELP = `
Wilson CLI — deployment orchestration

Usage:
  wilson status              Show all services (running/stopped, PID, port, version)
  wilson health              Check health endpoints for all services
  wilson logs <source> [n]   Show last n log lines (default: 20)
  wilson restart <service>   Restart a service via its CLI
  wilson update [service]    Run update check (all or specific service)
  wilson version             Show Wilson + all service versions

Services: ${getServiceNames().join(", ")}
Log sources: ${getServiceNames().join(", ")}, updater

Options:
  --json                     Machine-readable JSON output
  --version, -v              Show version
  --help, -h                 Show help
`;

export function parseArgs(args: string[]): {
  command: string;
  args: string[];
  json: boolean;
} {
  const filtered = args.filter((a) => a !== "--json");
  const json = args.includes("--json");
  const [command = "help", ...rest] = filtered;
  return { command, args: rest, json };
}

// --- Main ---

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(HELP);
    process.exit(0);
  }

  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { command, args, json } = parseArgs(rawArgs);

  switch (command) {
    case "status":
      await cmdStatus(json);
      process.exit(0);
      break;
    case "health":
      await cmdHealth(json);
      process.exit(0);
      break;
    case "logs":
      cmdLogs(args, json);
      process.exit(0);
      break;
    case "restart": {
      const exitCode = await cmdRestart(args, json);
      process.exit(exitCode);
      break;
    }
    case "update":
      await cmdUpdate(args, json);
      process.exit(0);
      break;
    case "version":
      await cmdVersion(json);
      process.exit(0);
      break;
    case "help":
      console.log(HELP);
      process.exit(0);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

// Only run when executed directly, not when imported by tests
const isDirectRun =
  import.meta.path === Bun.main || process.argv[1]?.endsWith("cli.ts");
if (isDirectRun) {
  main();
}
