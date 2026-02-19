import { err, ok, type Result } from "@shetty4l/core/result";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SERVICES, WILSON_CONFIG } from "./services";
import { VERSION } from "./version";

interface HealthResponse {
  status?: string;
  version?: string;
}

interface ServiceStatus {
  name: string;
  status: "running" | "stopped" | "unreachable" | "ok";
  version: string;
  port: number | null;
  pid: number | null;
}

async function fetchHealth(
  url: string,
): Promise<Result<HealthResponse, string>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const data = (await res.json()) as HealthResponse;
    return ok(data);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return err("request timed out");
    }
    if (e instanceof TypeError && e.message.includes("Unable to connect")) {
      return err("connection refused");
    }
    return err(e instanceof Error ? e.message : "unknown error");
  }
}

async function checkService(
  svc: (typeof SERVICES)[number],
): Promise<ServiceStatus> {
  let version = "not installed";
  if (existsSync(svc.currentVersionFile)) {
    version = readFileSync(svc.currentVersionFile, "utf-8").trim();
  }

  // Read PID from daemon manager's PID file
  const pidFile = join(svc.configDir, `${svc.name}.pid`);
  let pid: number | null = null;
  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) pid = parsed;
  }

  const result = await fetchHealth(svc.healthUrl);

  if (result.ok) {
    return {
      name: svc.name,
      status: "running",
      version: result.value.version ?? version,
      port: svc.port,
      pid,
    };
  }

  return {
    name: svc.name,
    status: existsSync(svc.cliPath) ? "stopped" : "unreachable",
    version,
    port: null,
    pid: null,
  };
}

export async function cmdStatus(json: boolean): Promise<void> {
  const results: ServiceStatus[] = await Promise.all(
    SERVICES.map(checkService),
  );

  // Add Wilson itself
  let wilsonVersion = VERSION;
  if (existsSync(WILSON_CONFIG.currentVersionFile)) {
    wilsonVersion = readFileSync(
      WILSON_CONFIG.currentVersionFile,
      "utf-8",
    ).trim();
  }
  results.push({
    name: "wilson",
    status: "ok",
    version: wilsonVersion,
    port: null,
    pid: null,
  });

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Table output
  const nameW = 10;
  const statusW = 13;
  const versionW = 12;
  const portW = 6;
  const pidW = 8;

  console.log(
    `\n${"Service".padEnd(nameW)}  ${"Status".padEnd(statusW)}  ${"Version".padEnd(versionW)}  ${"Port".padEnd(portW)}  PID`,
  );
  console.log("-".repeat(nameW + statusW + versionW + portW + pidW + 8));

  for (const r of results) {
    const status = r.status === "running" ? "running" : r.status;
    const port = r.port ? String(r.port) : "-";
    const pid = r.pid ? String(r.pid) : "-";

    console.log(
      `${r.name.padEnd(nameW)}  ${status.padEnd(statusW)}  ${r.version.padEnd(versionW)}  ${port.padEnd(portW)}  ${pid}`,
    );
  }

  console.log();
}
