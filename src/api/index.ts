import type { WilsonConfig } from "../config";
import { fetchHealth, type HealthResponse } from "../health";
import { getServices } from "../services";
import { fetchLatestVersion, readGithubToken } from "../update";
import { handleRestartAction, handleUpdateAction } from "./actions";
import { computeIndicators } from "./indicators";
import { ALLOWED_SERVICES, handleLogsStream, isAllowedService } from "./logs";
import { fetchAllStats } from "./stats";

export interface ServiceHealthInfo {
  name: string;
  port: number;
  status: "running" | "stopped";
  version: string | null;
  latestVersion: string | null;
  healthy: boolean;
}

/**
 * Fetch health for all services, including latest version from GitHub.
 */
async function fetchAllHealth(
  config: WilsonConfig,
): Promise<ServiceHealthInfo[]> {
  const services = getServices(config);
  const token = readGithubToken();

  // Fetch health and latest versions in parallel
  const results = await Promise.all(
    services.map(async (svc) => {
      // Fetch health and latest version in parallel for each service
      const [healthResult, latestVersionResult] = await Promise.all([
        fetchHealth(svc.healthUrl),
        fetchLatestVersion(svc, token),
      ]);

      const latestVersion = latestVersionResult.ok
        ? latestVersionResult.value
        : null;

      if (healthResult.ok) {
        const data = healthResult.value as HealthResponse;
        return {
          name: svc.name,
          port: svc.port,
          status: "running" as const,
          version: data.version ?? null,
          latestVersion,
          healthy: data.status === "healthy",
        };
      }

      return {
        name: svc.name,
        port: svc.port,
        status: "stopped" as const,
        version: null,
        latestVersion,
        healthy: false,
      };
    }),
  );

  return results;
}

/**
 * Handle API requests for /api/* paths.
 * Returns null for non-matching paths (404).
 */
export async function handleApiRequest(
  req: Request,
  url: URL,
  config: WilsonConfig,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  // GET /api/stats
  if (path === "/api/stats" && method === "GET") {
    const stats = await fetchAllStats(config);
    return Response.json(stats);
  }

  // GET /api/indicators
  if (path === "/api/indicators" && method === "GET") {
    const stats = await fetchAllStats(config);
    const indicators = computeIndicators(stats);
    return Response.json(indicators);
  }

  // GET /api/health
  if (path === "/api/health" && method === "GET") {
    const health = await fetchAllHealth(config);
    return Response.json(health);
  }

  // GET /api/logs/stream
  if (path === "/api/logs/stream" && method === "GET") {
    const service = url.searchParams.get("service");

    if (!service) {
      return Response.json(
        {
          error: `service query param required. Allowed: ${ALLOWED_SERVICES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    if (!isAllowedService(service)) {
      return Response.json(
        {
          error: `Invalid service: ${service}. Allowed: ${ALLOWED_SERVICES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    return handleLogsStream(service);
  }

  // POST /api/actions/restart
  if (path === "/api/actions/restart" && method === "POST") {
    try {
      const body = (await req.json()) as { service?: string };
      const serviceName = body?.service;

      if (!serviceName || typeof serviceName !== "string") {
        return Response.json(
          { success: false, error: "service name required" },
          { status: 400 },
        );
      }

      const result = await handleRestartAction(serviceName, config);

      if (result.ok) {
        return Response.json({ success: true });
      }

      return Response.json({ success: false, error: result.error });
    } catch {
      return Response.json(
        { success: false, error: "invalid request body" },
        { status: 400 },
      );
    }
  }

  // POST /api/actions/update
  if (path === "/api/actions/update" && method === "POST") {
    try {
      const body = (await req.json()) as { service?: string };
      const serviceName = body?.service;

      if (!serviceName || typeof serviceName !== "string") {
        return Response.json(
          { success: false, error: "service name required" },
          { status: 400 },
        );
      }

      const result = await handleUpdateAction(serviceName, config);

      if (result.ok) {
        return Response.json({ success: true, ...result.value });
      }

      return Response.json({ success: false, error: result.error });
    } catch {
      return Response.json(
        { success: false, error: "invalid request body" },
        { status: 400 },
      );
    }
  }

  // Not an API route we handle
  return null;
}

export { handleRestartAction, handleUpdateAction } from "./actions";
export type { Indicator, IndicatorStatus } from "./indicators";
export { computeIndicators } from "./indicators";
export { ALLOWED_SERVICES, handleLogsStream, isAllowedService } from "./logs";
// Re-export types for convenience
export type { HealthStatus, ServiceStats } from "./stats";
export { fetchAllStats } from "./stats";
