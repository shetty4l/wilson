import type { WilsonConfig } from "../config";
import { computeIndicators } from "./indicators";
import { fetchAllStats } from "./stats";

/**
 * Handle API requests for /api/* paths.
 * Returns null for non-matching paths (404).
 */
export async function handleApiRequest(
  _req: Request,
  url: URL,
  config: WilsonConfig,
): Promise<Response | null> {
  const path = url.pathname;

  // GET /api/stats
  if (path === "/api/stats") {
    const stats = await fetchAllStats(config);
    return Response.json(stats);
  }

  // GET /api/indicators
  if (path === "/api/indicators") {
    const stats = await fetchAllStats(config);
    const indicators = computeIndicators(stats);
    return Response.json(indicators);
  }

  // Not an API route we handle
  return null;
}

export type { Indicator, IndicatorStatus } from "./indicators";
export { computeIndicators } from "./indicators";
// Re-export types for convenience
export type { HealthStatus, ServiceStats } from "./stats";
export { fetchAllStats } from "./stats";
