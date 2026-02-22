import { err, ok, type Result } from "@shetty4l/core/result";
import { SERVICES } from "./services";

interface ProviderHealth {
  name: string;
  healthy: boolean;
  reachable: boolean;
  consecutiveFailures: number;
}

export interface HealthResponse {
  status: string;
  version?: string;
  providers?: ProviderHealth[];
  [key: string]: unknown;
}

interface ServiceHealth {
  name: string;
  port: number;
  reachable: boolean;
  data: HealthResponse | null;
  error: string | null;
}

export async function fetchHealth(
  url: string,
): Promise<Result<HealthResponse, string>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
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
    return err(e instanceof Error ? e.message : "not reachable");
  }
}

async function checkHealth(
  svc: (typeof SERVICES)[number],
): Promise<ServiceHealth> {
  const result = await fetchHealth(svc.healthUrl);

  if (result.ok) {
    return {
      name: svc.name,
      port: svc.port,
      reachable: true,
      data: result.value,
      error: null,
    };
  }

  return {
    name: svc.name,
    port: svc.port,
    reachable: false,
    data: null,
    error: result.error,
  };
}

export async function cmdHealth(json: boolean): Promise<void> {
  const results: ServiceHealth[] = await Promise.all(SERVICES.map(checkHealth));

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const r of results) {
    console.log(`\n=== ${r.name} (port ${r.port}) ===`);

    if (!r.reachable) {
      console.log(`  Status: not reachable (${r.error})`);
      continue;
    }

    const data = r.data!;
    const status = data.status === "healthy" ? "healthy" : "degraded";
    console.log(`  Status: ${status}`);
    if (data.version) {
      console.log(`  Version: ${data.version}`);
    }

    // Show provider-level health if available (synapse)
    if (data.providers && data.providers.length > 0) {
      const nameW = Math.max(10, ...data.providers.map((p) => p.name.length));

      console.log();
      console.log(
        `  ${"Provider".padEnd(nameW)}  ${"Healthy".padEnd(9)}  ${"Reachable".padEnd(11)}  Failures`,
      );
      console.log(`  ${"-".repeat(nameW + 9 + 11 + 10 + 6)}`);

      for (const p of data.providers) {
        const healthy = p.healthy ? "yes" : "NO";
        const reachable = p.reachable ? "yes" : "NO";
        console.log(
          `  ${p.name.padEnd(nameW)}  ${healthy.padEnd(9)}  ${reachable.padEnd(11)}  ${p.consecutiveFailures}`,
        );
      }
    }
  }

  console.log();
}
