import type { ApiCore } from "./core";
import type {
  FleetController,
  FleetControllerImportResult,
  FleetControllerInput,
  FleetControllerUpdateInput,
  FleetModelEntry,
  FleetRoute,
  FleetRouteInput,
  FleetRouteUpdateInput,
  FleetStatusResponse,
} from "@/lib/types";

type FleetApi = {
  getFleetControllers: () => Promise<FleetController[]>;
  getFleetControllerById: (id: string) => Promise<FleetController>;
  createFleetController: (input: FleetControllerInput) => Promise<FleetController>;
  updateFleetController: (
    id: string,
    input: FleetControllerUpdateInput,
  ) => Promise<FleetController>;
  deleteFleetController: (id: string) => Promise<{ success: true }>;
  importFleetControllers: (
    controllers: FleetControllerInput[],
  ) => Promise<FleetControllerImportResult>;
  getFleetStatus: (timeoutMs?: number) => Promise<FleetStatusResponse>;
  refreshFleetStatus: () => Promise<FleetStatusResponse>;
  getFleetModels: () => Promise<FleetModelEntry[]>;
  getFleetRoutes: () => Promise<FleetRoute[]>;
  getFleetRouteById: (id: string) => Promise<FleetRoute>;
  createFleetRoute: (route: FleetRouteInput) => Promise<FleetRoute>;
  updateFleetRoute: (id: string, route: FleetRouteUpdateInput) => Promise<FleetRoute>;
  deleteFleetRoute: (id: string) => Promise<{ success: boolean }>;
  runFleetRouteChatCompletion: (
    id: string,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/%2F/gi, "%252F");

type FleetControllersCache = { expiresAt: number; promise: Promise<FleetController[]> };
let fleetControllersCache: FleetControllersCache | null = null;
const FLEET_CONTROLLERS_CACHE_MS = 10_000;

function clearFleetControllersCache(): void {
  fleetControllersCache = null;
}

function getCachedFleetControllers(core: ApiCore): Promise<FleetController[]> {
  const now = Date.now();
  if (fleetControllersCache && fleetControllersCache.expiresAt > now) {
    return fleetControllersCache.promise;
  }
  const promise = core.request<FleetController[]>("/fleet/controllers", { retries: 0 });
  fleetControllersCache = { expiresAt: now + FLEET_CONTROLLERS_CACHE_MS, promise };
  void promise.catch(() => {
    if (fleetControllersCache?.promise === promise) clearFleetControllersCache();
  });
  return promise;
}

export const createFleetApi = (core: ApiCore): FleetApi => ({
  getFleetControllers: () => getCachedFleetControllers(core),
  getFleetControllerById: (id) =>
    core.request<FleetController>(`/fleet/controllers/${encodePathSegment(id)}`),
  createFleetController: (input) => {
    clearFleetControllersCache();
    return core.request<FleetController>("/fleet/controllers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateFleetController: (id, input) => {
    clearFleetControllersCache();
    return core.request<FleetController>(`/fleet/controllers/${encodePathSegment(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  deleteFleetController: (id) => {
    clearFleetControllersCache();
    return core.request<{ success: true }>(`/fleet/controllers/${encodePathSegment(id)}`, {
      method: "DELETE",
    });
  },
  importFleetControllers: (controllers) => {
    clearFleetControllersCache();
    return core.request<FleetControllerImportResult>("/fleet/controllers/import", {
      method: "POST",
      body: JSON.stringify({ controllers }),
    });
  },
  getFleetStatus: (timeoutMs) => {
    const query =
      typeof timeoutMs === "number" ? `?timeoutMs=${encodeURIComponent(String(timeoutMs))}` : "";
    return core.request<FleetStatusResponse>(`/fleet/status${query}`);
  },
  refreshFleetStatus: () =>
    core.request<FleetStatusResponse>("/fleet/status/refresh", { method: "POST" }),
  getFleetModels: () => core.request<FleetModelEntry[]>("/fleet/models"),
  getFleetRoutes: () => core.request<FleetRoute[]>("/fleet/routes"),
  getFleetRouteById: (id) => core.request<FleetRoute>(`/fleet/routes/${encodePathSegment(id)}`),
  createFleetRoute: (input) =>
    core.request<FleetRoute>("/fleet/routes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateFleetRoute: (id, input) =>
    core.request<FleetRoute>(`/fleet/routes/${encodePathSegment(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteFleetRoute: (id) =>
    core.request<{ success: boolean }>(`/fleet/routes/${encodePathSegment(id)}`, {
      method: "DELETE",
    }),
  runFleetRouteChatCompletion: (id, payload) =>
    core.request<Record<string, unknown>>(
      `/fleet/routes/${encodePathSegment(id)}/v1/chat/completions`,
      { method: "POST", body: JSON.stringify(payload), timeout: 120_000, retries: 0 },
    ),
});
