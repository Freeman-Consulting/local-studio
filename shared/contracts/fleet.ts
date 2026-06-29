export type FleetControllerRole = "control-plane" | "inference" | "specialist" | "operator-client";

export type FleetControllerStatus = "unknown" | "online" | "offline" | "degraded";

export interface FleetControllerInput {
  url: string;
  apiKey?: string;
  name?: string;
  role?: FleetControllerRole;
  enabled?: boolean;
  notes?: string;
}

export interface FleetControllerUpdateInput {
  url?: string;
  apiKey?: string;
  name?: string;
  role?: FleetControllerRole;
  enabled?: boolean;
  notes?: string;
}

export interface FleetController {
  id: string;
  url: string;
  name: string;
  hasApiKey: boolean;
  role: FleetControllerRole;
  enabled: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetControllerImportResult {
  controllers: FleetController[];
  imported: string[];
  skipped: string[];
}

export interface FleetControllerStatusResult {
  controllerId: string;
  url: string;
  name: string;
  status: FleetControllerStatus;
  latencyMs: number | null;
  activeModel: string | null;
  backend: string | null;
  error: string | null;
  checkedAt: string;
}

export interface FleetModelEntry {
  id: string;
  controllerId: string;
  controllerName: string;
  modelId: string;
  backend: string | null;
  checkedAt: string;
}

export interface FleetStatusResponse {
  checkedAt: string;
  controllers: FleetControllerStatusResult[];
  models: FleetModelEntry[];
}
