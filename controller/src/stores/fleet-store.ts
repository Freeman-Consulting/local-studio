import type { Database } from "bun:sqlite";
import type {
  FleetController,
  FleetControllerInput,
  FleetControllerRole,
  FleetControllerStatus,
  FleetControllerStatusResult,
  FleetControllerUpdateInput,
  FleetModelEntry,
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
