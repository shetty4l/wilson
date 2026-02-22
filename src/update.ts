import { err, ok, type Result } from "@shetty4l/core/result";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  getService,
  getServiceNames,
  SERVICES,
  type ServiceConfig,
} from "./services";

const GITHUB_TOKEN_PATH = join(homedir(), ".config", "wilson", "github-token");

export function readGithubToken(): string | null {
  try {
    if (!existsSync(GITHUB_TOKEN_PATH)) return null;
    const content = readFileSync(GITHUB_TOKEN_PATH, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

export function readCurrentVersion(svc: ServiceConfig): string | null {
  try {
    if (!existsSync(svc.currentVersionFile)) return null;
    const content = readFileSync(svc.currentVersionFile, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

export async function fetchLatestVersion(
  svc: ServiceConfig,
  token: string | null,
): Promise<Result<string, string>> {
  const url = `https://api.github.com/repos/${svc.repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return err(`GitHub API returned ${res.status} for ${svc.repo}`);
    }

    const data = (await res.json()) as { tag_name?: string };
    if (!data.tag_name) {
      return err(`no tag_name in release response for ${svc.repo}`);
    }

    const version = data.tag_name.replace(/^v/, "");
    return ok(version);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return err(`GitHub API request timed out for ${svc.repo}`);
    }
    return err(
      `failed to fetch latest version for ${svc.repo}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function installUpdate(
  svc: ServiceConfig,
  token: string | null,
): Promise<Result<void, string>> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? homedir(),
    SKIP_LAUNCHAGENT_RELOAD: "1",
  };
  if (token) {
    env.GITHUB_TOKEN = token;
  }

  const installCmd = `curl -fsSL https://raw.githubusercontent.com/${svc.repo}/main/scripts/install.sh | bash`;

  try {
    const proc = Bun.spawn(["bash", "-c", installCmd], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const timeoutMs = 120_000;
    const result = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      ),
    ]);

    if (result === "timeout") {
      proc.kill();
      return err(
        `install timed out after ${timeoutMs / 1000}s for ${svc.name}`,
      );
    }

    if (result !== 0) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      return err(
        `install failed for ${svc.name} (exit ${result})${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }

    return ok(undefined);
  } catch (e) {
    return err(
      `install error for ${svc.name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function restartService(
  svc: ServiceConfig,
): Promise<Result<void, string>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    try {
      const proc = Bun.spawn([svc.cliPath, "restart"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        return ok(undefined);
      }

      // On first failure, retry
      if (attempt === 0) continue;

      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      return err(
        `restart failed for ${svc.name} (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    } catch (e) {
      if (attempt === 0) continue;
      return err(
        `restart error for ${svc.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Unreachable, but TypeScript needs it
  return err(`restart failed for ${svc.name}`);
}

export interface UpdateResult {
  updated: boolean;
  from?: string;
  to?: string;
  error?: string;
}

export async function checkAndUpdate(
  svc: ServiceConfig,
  token: string | null,
  log: (msg: string) => void,
): Promise<UpdateResult> {
  const current = readCurrentVersion(svc);
  log(`${svc.name}: current version ${current ?? "unknown"}`);

  const latestResult = await fetchLatestVersion(svc, token);
  if (!latestResult.ok) {
    return { updated: false, error: latestResult.error };
  }
  const latest = latestResult.value;
  log(`${svc.name}: latest version ${latest}`);

  if (current === latest) {
    log(`${svc.name}: up to date`);
    return { updated: false };
  }

  log(`${svc.name}: updating ${current ?? "unknown"} → ${latest}`);

  const installResult = await installUpdate(svc, token);
  if (!installResult.ok) {
    return { updated: false, error: installResult.error };
  }

  log(`${svc.name}: restarting`);
  const restartResult = await restartService(svc);
  if (!restartResult.ok) {
    return { updated: false, error: restartResult.error };
  }

  log(`${svc.name}: updated ${current ?? "unknown"} → ${latest}`);
  return { updated: true, from: current ?? undefined, to: latest };
}

export async function cmdUpdate(
  args: string[],
  json: boolean,
): Promise<number> {
  const token = readGithubToken();

  const log = (msg: string) => {
    if (!json) console.log(msg);
  };

  const serviceName = args[0];

  if (serviceName) {
    const svcResult = getService(serviceName);
    if (!svcResult.ok) {
      if (json) {
        console.log(
          JSON.stringify({ service: serviceName, error: svcResult.error }),
        );
      } else {
        console.error(`Error: ${svcResult.error}`);
        console.error(`Services: ${getServiceNames().join(", ")}`);
      }
      return 1;
    }

    const result = await checkAndUpdate(svcResult.value, token, log);

    if (json) {
      console.log(JSON.stringify({ service: serviceName, ...result }));
    }

    return result.error ? 1 : 0;
  }

  // Update all services
  log("Running update check for all services...\n");

  let hasError = false;
  const results: Array<{ service: string } & UpdateResult> = [];

  for (const svc of SERVICES) {
    const result = await checkAndUpdate(svc, token, log);
    results.push({ service: svc.name, ...result });
    if (result.error) hasError = true;
    if (!json) console.log();
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  }

  return hasError ? 1 : 0;
}
