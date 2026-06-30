import type { FleetRoute } from "../../../../shared/contracts/fleet";
import type { ProcessInfo } from "../../../../shared/contracts/observability";

export interface ActiveFleetRouteState {
  get(): FleetRoute | null;
  set(route: FleetRoute | null): void;
  clear(): void;
  isActive(routeIdOrName: string): boolean;
  toProcess(): ProcessInfo | null;
}

export const createActiveFleetRouteState = (): ActiveFleetRouteState => {
  let activeRoute: FleetRoute | null = null;

  const toProcess = (): ProcessInfo | null => {
    if (!activeRoute) return null;
    let port = 0;
    try {
      const endpoint = new URL(activeRoute.endpointUrl || activeRoute.controllerUrl);
      port = Number(endpoint.port || 0);
    } catch {
      port = 0;
    }
    return {
      pid: 0,
      backend: `fleet:${activeRoute.controllerName || "route"}`,
      model_path: activeRoute.endpointUrl || activeRoute.controllerUrl,
      port,
      served_model_name: `fleet/${activeRoute.name}`,
    };
  };

  return {
    get: () => activeRoute,
    set: (route) => {
      activeRoute = route;
    },
    clear: () => {
      activeRoute = null;
    },
    isActive: (routeIdOrName) =>
      Boolean(activeRoute && (activeRoute.id === routeIdOrName || activeRoute.name === routeIdOrName)),
    toProcess,
  };
};
