import type { Database } from "bun:sqlite";
import type {
  FleetController,
  FleetControllerInput,
  FleetControllerRole,
  FleetControllerStatus,
  FleetControllerStatusResult,
  FleetControllerUpdateInput,
  FleetModelEntry,
  FleetRoute,
  FleetRouteInput,
  FleetRouteUpdateInput,
} from "../../../shared/contracts/fleet";
import { openSqliteDatabase } from "./sqlite";

type FleetControllerRow = {
  id: string;
  url: string;
  name: string | null;
  api_key: string | null;
  role: string;
  enabled: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type FleetModelRow = {
  id: string;
  controller_id: string;
  controller_name: string;
  model_id: string;
  backend: string | null;
  checked_at: string;
};

type FleetRouteRow = {
  id: string;
  name: string;
  controller_id: string;
  controller_name: string;
  controller_url: string;
  model_id: string;
  enabled: number;
  fallback_route_id: string | null;
  tags_json: string;
  trust_level: string;
  disruption_cost: string;
  default_params_json: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type FleetProbeTarget = FleetController & { apiKey: string | null };

type StatusBody = {
  running?: unknown;
  process?: {
    backend?: unknown;
    model_path?: unknown;
    served_model_name?: unknown;
  } | null;
};

type ModelListBody = {
  data?: Array<{ id?: unknown; backend?: unknown }>;
};

const FLEET_CONTROLLER_ROLES = ["control-plane", "inference", "specialist", "operator-client"] as const;
const DEFAULT_ROLE: FleetControllerRole = "inference";
const DEFAULT_FANOUT_CONCURRENCY = 5;
const DEFAULT_MODEL_TIMEOUT_MS = 10_000;

const now = (): string => new Date().toISOString();

const trimString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const normalizeRole = (value: unknown): FleetControllerRole => {
  const role = trimString(value).toLowerCase();
  return FLEET_CONTROLLER_ROLES.includes(role as FleetControllerRole) ? (role as FleetControllerRole) : DEFAULT_ROLE;
};

export const normalizeFleetControllerUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("fleet controller url must be http(s)");
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/i, "") || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

const mapController = (row: FleetControllerRow): FleetController => ({
  id: row.id,
  url: row.url,
  name: row.name ?? "",
  hasApiKey: Boolean(row.api_key),
  role: normalizeRole(row.role),
  enabled: Boolean(row.enabled),
  notes: row.notes ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapProbeTarget = (row: FleetControllerRow): FleetProbeTarget => ({
  ...mapController(row),
  apiKey: row.api_key,
});

const mapModel = (row: FleetModelRow): FleetModelEntry => ({
  id: row.id,
  controllerId: row.controller_id,
  controllerName: row.controller_name,
  modelId: row.model_id,
  backend: row.backend,
  checkedAt: row.checked_at,
});

const parseStringArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const parseRecord = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const mapRoute = (row: FleetRouteRow): FleetRoute => ({
  id: row.id,
  name: row.name,
  controllerId: row.controller_id,
  controllerName: row.controller_name,
  controllerUrl: row.controller_url,
  modelId: row.model_id,
  enabled: Boolean(row.enabled),
  fallbackRouteId: row.fallback_route_id,
  tags: parseStringArray(row.tags_json),
  trustLevel: row.trust_level,
  disruptionCost: row.disruption_cost,
  defaultParams: parseRecord(row.default_params_json),
  notes: row.notes ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const withTimeout = async (url: string, apiKey: string | null, timeoutMs: number): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  return fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
};

const parseStatusBody = (body: unknown): Pick<FleetControllerStatusResult, "activeModel" | "backend"> => {
  if (!body || typeof body !== "object") return { activeModel: null, backend: null };
  const status = body as StatusBody;
  const process = status.process && typeof status.process === "object" ? status.process : null;
  const activeModel = trimString(process?.served_model_name) || trimString(process?.model_path) || null;
  const backend = trimString(process?.backend) || null;
  return { activeModel, backend };
};

const parseModelEntries = (controller: FleetProbeTarget, body: unknown, checkedAt: string): FleetModelEntry[] => {
  if (!body || typeof body !== "object") return [];
  const data = Array.isArray((body as ModelListBody).data) ? (body as ModelListBody).data ?? [] : [];
  return data.flatMap((entry) => {
    const modelId = trimString(entry.id);
    if (!modelId) return [];
    return [{
      id: `${controller.id}:${modelId}`,
      controllerId: controller.id,
      controllerName: controller.name,
      modelId,
      backend: trimString(entry.backend) || null,
      checkedAt,
    }];
  });
};

const chunked = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const runBounded = async <Input, Output>(
  items: Input[],
  worker: (item: Input) => Promise<Output>,
  concurrency = DEFAULT_FANOUT_CONCURRENCY,
): Promise<Output[]> => {
  const results: Output[] = [];
  for (const batch of chunked(items, concurrency)) results.push(...await Promise.all(batch.map(worker)));
  return results;
};

export interface FleetStore {
  list(): FleetController[];
  get(id: string): FleetController | null;
  getByUrl(url: string): FleetController | null;
  create(input: FleetControllerInput): FleetController;
  update(id: string, input: FleetControllerUpdateInput): FleetController | null;
  delete(id: string): boolean;
  importControllers(inputs: FleetControllerInput[]): { controllers: FleetController[]; imported: string[]; skipped: string[] };
  listModels(): FleetModelEntry[];
  upsertModels(models: FleetModelEntry[]): void;
  listRoutes(): FleetRoute[];
  getRoute(id: string): FleetRoute | null;
  getRouteByName(name: string): FleetRoute | null;
  createRoute(input: FleetRouteInput): FleetRoute;
  updateRoute(id: string, input: FleetRouteUpdateInput): FleetRoute | null;
  deleteRoute(id: string): boolean;
  probeControllers(timeoutMs: number): Promise<FleetControllerStatusResult[]>;
  probeFleetModels(timeoutMs?: number): Promise<FleetModelEntry[]>;
}

export class SqliteFleetStore implements FleetStore {
  private readonly db: Database;

  public constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fleet_controllers (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        api_key TEXT,
        role TEXT NOT NULL DEFAULT 'inference',
        enabled INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_fleet_controllers_enabled ON fleet_controllers(enabled)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fleet_models (
        id TEXT PRIMARY KEY,
        controller_id TEXT NOT NULL,
        controller_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        backend TEXT,
        checked_at TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_fleet_models_controller_id ON fleet_models(controller_id)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fleet_routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        controller_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        fallback_route_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        trust_level TEXT NOT NULL DEFAULT '',
        disruption_cost TEXT NOT NULL DEFAULT '',
        default_params_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (controller_id) REFERENCES fleet_controllers(id) ON DELETE CASCADE,
        FOREIGN KEY (fallback_route_id) REFERENCES fleet_routes(id) ON DELETE SET NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_fleet_routes_controller_id ON fleet_routes(controller_id)");
  }

  public list(): FleetController[] {
    return this.listRows().map(mapController);
  }

  public get(id: string): FleetController | null {
    const row = this.db.query<FleetControllerRow, [string]>("SELECT * FROM fleet_controllers WHERE id = ?").get(id);
    return row ? mapController(row) : null;
  }

  public getByUrl(url: string): FleetController | null {
    const normalized = normalizeFleetControllerUrl(url);
    const row = this.db.query<FleetControllerRow, [string]>("SELECT * FROM fleet_controllers WHERE url = ?").get(normalized);
    return row ? mapController(row) : null;
  }

  public create(input: FleetControllerInput): FleetController {
    const controller = this.prepareController(input);
    this.db.query(`
      INSERT INTO fleet_controllers (id, url, name, api_key, role, enabled, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      controller.id,
      controller.url,
      controller.name,
      controller.apiKey,
      controller.role,
      controller.enabled ? 1 : 0,
      controller.notes,
      controller.createdAt,
      controller.updatedAt,
    );
    return this.get(controller.id)!;
  }

  public update(id: string, input: FleetControllerUpdateInput): FleetController | null {
    const existing = this.db.query<FleetControllerRow, [string]>("SELECT * FROM fleet_controllers WHERE id = ?").get(id);
    if (!existing) return null;
    const hasApiKeyField = Object.hasOwn(input, "apiKey");
    const url = input.url === undefined ? existing.url : normalizeFleetControllerUrl(input.url);
    const conflicting = url !== existing.url ? this.getByUrl(url) : null;
    if (conflicting) throw new Error("fleet controller already registered with this url");
    const name = input.name === undefined ? existing.name ?? "" : trimString(input.name);
    const apiKey = hasApiKeyField ? trimString(input.apiKey ?? "") || null : existing.api_key;
    const role = input.role === undefined ? normalizeRole(existing.role) : normalizeRole(input.role);
    const enabled = input.enabled === undefined ? Boolean(existing.enabled) : Boolean(input.enabled);
    const notes = input.notes === undefined ? existing.notes ?? "" : trimString(input.notes);
    const updatedAt = now();
    this.db.query(`
      UPDATE fleet_controllers
      SET url = ?, name = ?, api_key = ?, role = ?, enabled = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(url, name, apiKey, role, enabled ? 1 : 0, notes, updatedAt, id);
    return this.get(id);
  }

  public delete(id: string): boolean {
    const result = this.db.query("DELETE FROM fleet_controllers WHERE id = ?").run(id);
    this.db.query("DELETE FROM fleet_models WHERE controller_id = ?").run(id);
    return result.changes > 0;
  }

  public importControllers(inputs: FleetControllerInput[]): { controllers: FleetController[]; imported: string[]; skipped: string[] } {
    const controllers: FleetController[] = [];
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const input of inputs) {
      const url = normalizeFleetControllerUrl(input.url);
      const existing = this.getByUrl(url);
      if (existing) {
        skipped.push(existing.id);
        controllers.push(existing);
        continue;
      }
      const controller = this.create({ ...input, url });
      imported.push(controller.id);
      controllers.push(controller);
    }
    return { controllers, imported, skipped };
  }

  public listModels(): FleetModelEntry[] {
    return this.db.query<FleetModelRow, []>("SELECT * FROM fleet_models ORDER BY controller_name ASC, model_id ASC").all().map(mapModel);
  }

  public upsertModels(models: FleetModelEntry[]): void {
    const insert = this.db.query(`
      INSERT INTO fleet_models (id, controller_id, controller_name, model_id, backend, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((entries: FleetModelEntry[]) => {
      this.db.run("DELETE FROM fleet_models");
      for (const entry of entries) {
        insert.run(entry.id, entry.controllerId, entry.controllerName, entry.modelId, entry.backend, entry.checkedAt);
      }
    });
    tx(models);
  }

  public listRoutes(): FleetRoute[] {
    return this.routeQuery("ORDER BY r.created_at ASC, r.name ASC").map(mapRoute);
  }

  public getRoute(id: string): FleetRoute | null {
    const row = this.routeQuery("WHERE r.id = ?", id)[0];
    return row ? mapRoute(row) : null;
  }

  public getRouteByName(name: string): FleetRoute | null {
    const row = this.routeQuery("WHERE r.name = ?", this.normalizeRouteName(name))[0];
    return row ? mapRoute(row) : null;
  }

  public createRoute(input: FleetRouteInput): FleetRoute {
    const route = this.prepareRoute(input);
    this.db.query(`
      INSERT INTO fleet_routes (
        id, name, controller_id, model_id, enabled, fallback_route_id, tags_json,
        trust_level, disruption_cost, default_params_json, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      route.id,
      route.name,
      route.controllerId,
      route.modelId,
      route.enabled ? 1 : 0,
      route.fallbackRouteId,
      JSON.stringify(route.tags),
      route.trustLevel,
      route.disruptionCost,
      JSON.stringify(route.defaultParams),
      route.notes,
      route.createdAt,
      route.updatedAt,
    );
    return this.getRoute(route.id)!;
  }

  public updateRoute(id: string, input: FleetRouteUpdateInput): FleetRoute | null {
    const existing = this.db.query<FleetRouteRow, [string]>("SELECT * FROM fleet_routes WHERE id = ?").get(id);
    if (!existing) return null;
    const route = this.prepareRoute({
      name: input.name ?? existing.name,
      controllerId: input.controllerId ?? existing.controller_id,
      modelId: input.modelId ?? existing.model_id,
      enabled: input.enabled ?? Boolean(existing.enabled),
      fallbackRouteId: input.fallbackRouteId === undefined ? existing.fallback_route_id : input.fallbackRouteId,
      tags: input.tags ?? parseStringArray(existing.tags_json),
      trustLevel: input.trustLevel ?? existing.trust_level,
      disruptionCost: input.disruptionCost ?? existing.disruption_cost,
      defaultParams: input.defaultParams ?? parseRecord(existing.default_params_json),
      notes: input.notes ?? existing.notes ?? "",
    }, id, existing.created_at);
    this.db.query(`
      UPDATE fleet_routes
      SET name = ?, controller_id = ?, model_id = ?, enabled = ?, fallback_route_id = ?,
          tags_json = ?, trust_level = ?, disruption_cost = ?, default_params_json = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      route.name,
      route.controllerId,
      route.modelId,
      route.enabled ? 1 : 0,
      route.fallbackRouteId,
      JSON.stringify(route.tags),
      route.trustLevel,
      route.disruptionCost,
      JSON.stringify(route.defaultParams),
      route.notes,
      route.updatedAt,
      id,
    );
    return this.getRoute(id);
  }

  public deleteRoute(id: string): boolean {
    this.db.query("UPDATE fleet_routes SET fallback_route_id = NULL WHERE fallback_route_id = ?").run(id);
    const result = this.db.query("DELETE FROM fleet_routes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  public async probeControllers(timeoutMs: number): Promise<FleetControllerStatusResult[]> {
    return runBounded(this.listProbeTargets(), (controller) => this.probeController(controller, timeoutMs));
  }

  public async probeFleetModels(timeoutMs = DEFAULT_MODEL_TIMEOUT_MS): Promise<FleetModelEntry[]> {
    const nested = await runBounded(this.listProbeTargets().filter((controller) => controller.enabled), async (controller) => {
      const checkedAt = now();
      try {
        const response = await withTimeout(`${controller.url}/v1/models`, controller.apiKey, timeoutMs);
        if (!response.ok) return [];
        return parseModelEntries(controller, await response.json().catch(() => null), checkedAt);
      } catch {
        return [];
      }
    });
    return nested.flat();
  }

  private listRows(): FleetControllerRow[] {
    return this.db.query<FleetControllerRow, []>("SELECT * FROM fleet_controllers ORDER BY created_at ASC, name ASC").all();
  }

  private listProbeTargets(): FleetProbeTarget[] {
    return this.listRows().map(mapProbeTarget);
  }

  private routeQuery(clause: string, ...params: string[]): FleetRouteRow[] {
    return this.db.query<FleetRouteRow, string[]>(`
      SELECT
        r.id,
        r.name,
        r.controller_id,
        c.name AS controller_name,
        c.url AS controller_url,
        r.model_id,
        r.enabled,
        r.fallback_route_id,
        r.tags_json,
        r.trust_level,
        r.disruption_cost,
        r.default_params_json,
        r.notes,
        r.created_at,
        r.updated_at
      FROM fleet_routes r
      JOIN fleet_controllers c ON c.id = r.controller_id
      ${clause}
    `).all(...params);
  }

  private normalizeRouteName(name: string): string {
    const normalized = trimString(name).toLowerCase();
    if (!normalized) throw new Error("fleet route name is required");
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(normalized)) {
      throw new Error("fleet route name must be 2-63 lowercase letters, numbers, dots, underscores, or dashes");
    }
    return normalized;
  }

  private normalizeRouteTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return Array.from(new Set(tags.map(trimString).filter(Boolean))).sort();
  }

  private normalizeDefaultParams(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private prepareRoute(input: FleetRouteInput, id: string = crypto.randomUUID(), createdAt = now()): FleetRoute {
    const controller = this.get(input.controllerId);
    if (!controller) throw new Error("fleet route controller not found");
    const fallbackRouteId = trimString(input.fallbackRouteId ?? "") || null;
    if (fallbackRouteId && !this.getRoute(fallbackRouteId)) throw new Error("fleet route fallback route not found");
    const timestamp = now();
    const modelId = trimString(input.modelId);
    if (!modelId) throw new Error("fleet route model id is required");
    return {
      id,
      name: this.normalizeRouteName(input.name),
      controllerId: controller.id,
      controllerName: controller.name,
      controllerUrl: controller.url,
      modelId,
      enabled: input.enabled ?? true,
      fallbackRouteId,
      tags: this.normalizeRouteTags(input.tags),
      trustLevel: trimString(input.trustLevel),
      disruptionCost: trimString(input.disruptionCost),
      defaultParams: this.normalizeDefaultParams(input.defaultParams),
      notes: trimString(input.notes),
      createdAt,
      updatedAt: timestamp,
    };
  }

  private prepareController(input: FleetControllerInput): FleetProbeTarget & { createdAt: string; updatedAt: string } {
    const timestamp = now();
    return {
      id: crypto.randomUUID(),
      url: normalizeFleetControllerUrl(input.url),
      name: trimString(input.name),
      hasApiKey: Boolean(trimString(input.apiKey ?? "")),
      apiKey: trimString(input.apiKey ?? "") || null,
      role: normalizeRole(input.role),
      enabled: input.enabled ?? true,
      notes: trimString(input.notes),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private async probeController(controller: FleetProbeTarget, timeoutMs: number): Promise<FleetControllerStatusResult> {
    const startedAt = performance.now();
    const checkedAt = now();
    if (!controller.enabled) return this.statusResult(controller, "unknown", null, null, null, "disabled", checkedAt);
    try {
      const health = await withTimeout(`${controller.url}/health`, controller.apiKey, timeoutMs);
      if (!health.ok) return this.statusResult(controller, "offline", Math.round(performance.now() - startedAt), null, null, `health returned ${health.status}`, checkedAt);
      const status = await withTimeout(`${controller.url}/status`, controller.apiKey, timeoutMs)
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null);
      const parsed = parseStatusBody(status);
      return this.statusResult(controller, "online", Math.round(performance.now() - startedAt), parsed.activeModel, parsed.backend, null, checkedAt);
    } catch (error) {
      return this.statusResult(controller, "offline", Math.round(performance.now() - startedAt), null, null, errorMessage(error), checkedAt);
    }
  }

  private statusResult(
    controller: FleetProbeTarget,
    status: FleetControllerStatus,
    latencyMs: number | null,
    activeModel: string | null,
    backend: string | null,
    error: string | null,
    checkedAt: string,
  ): FleetControllerStatusResult {
    return {
      controllerId: controller.id,
      url: controller.url,
      name: controller.name,
      status,
      latencyMs,
      activeModel,
      backend,
      error,
      checkedAt,
    };
  }
}

export const createFleetStore = (dbPath: string): FleetStore => new SqliteFleetStore(dbPath);
