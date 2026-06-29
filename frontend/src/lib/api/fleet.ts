import type { ApiCore } from "./core";
import type {
  FleetController,
  FleetControllerImportResult,
  FleetControllerInput,
  FleetControllerUpdateInput,
  FleetModelEntry,
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
};

const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/%2F/gi, "%252F");

export const createFleetApi = (core: ApiCore): FleetApi => ({
  getFleetControllers: () => core.request<FleetController[]>("/fleet/controllers"),
  getFleetControllerById: (id) =>
    core.request<FleetController>(`/fleet/controllers/${encodePathSegment(id)}`),
  createFleetController: (input) =>
    core.request<FleetController>("/fleet/controllers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateFleetController: (id, input) =>
    core.request<FleetController>(`/fleet/controllers/${encodePathSegment(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteFleetController: (id) =>
    core.request<{ success: true }>(`/fleet/controllers/${encodePathSegment(id)}`, {
      method: "DELETE",
    }),
  importFleetControllers: (controllers) =>
    core.request<FleetControllerImportResult>("/fleet/controllers/import", {
      method: "POST",
      body: JSON.stringify({ controllers }),
    }),
  getFleetStatus: (timeoutMs) => {
    const query =
      typeof timeoutMs === "number" ? `?timeoutMs=${encodeURIComponent(String(timeoutMs))}` : "";
    return core.request<FleetStatusResponse>(`/fleet/status${query}`);
  },
  refreshFleetStatus: () =>
    core.request<FleetStatusResponse>("/fleet/status/refresh", { method: "POST" }),
  getFleetModels: () => core.request<FleetModelEntry[]>("/fleet/models"),
});
