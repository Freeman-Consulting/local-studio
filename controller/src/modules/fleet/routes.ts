import { badRequest, notFound } from "../../core/errors";
import { parseJsonObjectBody } from "../../core/validation";
import type { RouteRegistrar } from "../../http/route-registrar";
import type { FleetControllerInput, FleetControllerRole, FleetControllerUpdateInput } from "../../../../shared/contracts/fleet";

const ROLES = new Set<FleetControllerRole>(["control-plane", "inference", "specialist", "operator-client"]);

const optionalText = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string`);
  return value.trim();
};

const optionalRole = (record: Record<string, unknown>): FleetControllerRole | undefined => {
  const value = record["role"];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest("role must be a string");
  const role = value.trim().toLowerCase() as FleetControllerRole;
  if (!ROLES.has(role)) throw badRequest("invalid fleet controller role");
  return role;
};

const optionalEnabled = (record: Record<string, unknown>): boolean | undefined => {
  const value = record["enabled"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest("enabled must be a boolean");
  return value;
};

const assignDefined = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void => {
  if (value !== undefined) target[key] = value;
};

const controllerInput = (record: Record<string, unknown>): FleetControllerInput => {
  const url = optionalText(record, "url");
  if (!url) throw badRequest("fleet controller url is required");
  const input: FleetControllerInput = { url };
  assignDefined(input, "apiKey", optionalText(record, "apiKey"));
  assignDefined(input, "name", optionalText(record, "name"));
  assignDefined(input, "role", optionalRole(record));
  assignDefined(input, "enabled", optionalEnabled(record));
  assignDefined(input, "notes", optionalText(record, "notes"));
  return input;
};

const controllerUpdate = (record: Record<string, unknown>): FleetControllerUpdateInput => {
  const input: FleetControllerUpdateInput = {};
  assignDefined(input, "url", optionalText(record, "url"));
  assignDefined(input, "apiKey", optionalText(record, "apiKey"));
  assignDefined(input, "name", optionalText(record, "name"));
  assignDefined(input, "role", optionalRole(record));
  assignDefined(input, "enabled", optionalEnabled(record));
  assignDefined(input, "notes", optionalText(record, "notes"));
  return input;
};

const importInputs = (record: Record<string, unknown>): FleetControllerInput[] => {
  const raw = record["controllers"] ?? record["savedControllers"];
  if (!Array.isArray(raw)) throw badRequest("controllers must be an array");
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    return [controllerInput(entry as Record<string, unknown>)];
  });
};

const timeoutMs = (raw: string | undefined): number => {
  const value = Number(raw ?? 5000);
  if (!Number.isFinite(value) || value <= 0) return 5000;
  return Math.min(Math.round(value), 30000);
};

const mapBadRequest = (error: unknown): never => {
  throw badRequest(error instanceof Error ? error.message : String(error));
};

export const registerFleetRoutes: RouteRegistrar = (app, context) => {
  const store = context.stores.fleetStore;

  app.get("/fleet/controllers", (ctx) => ctx.json(store.list()));

  app.get("/fleet/controllers/:id", (ctx) => {
    const controller = store.get(ctx.req.param("id"));
    if (!controller) throw notFound("fleet controller not found");
    return ctx.json(controller);
  });

  app.post("/fleet/controllers", async (ctx) => {
    try {
      const input = controllerInput(await parseJsonObjectBody(ctx));
      if (store.getByUrl(input.url)) throw badRequest("fleet controller already registered with this url");
      return ctx.json(store.create(input), { status: 201 });
    } catch (error) {
      return mapBadRequest(error);
    }
  });

  app.patch("/fleet/controllers/:id", async (ctx) => {
    let controller;
    try {
      controller = store.update(ctx.req.param("id"), controllerUpdate(await parseJsonObjectBody(ctx)));
    } catch (error) {
      return mapBadRequest(error);
    }
    if (!controller) throw notFound("fleet controller not found");
    return ctx.json(controller);
  });

  app.delete("/fleet/controllers/:id", (ctx) => {
    if (!store.delete(ctx.req.param("id"))) throw notFound("fleet controller not found");
    return ctx.json({ success: true });
  });

  app.post("/fleet/controllers/import", async (ctx) => {
    try {
      return ctx.json(store.importControllers(importInputs(await parseJsonObjectBody(ctx))));
    } catch (error) {
      return mapBadRequest(error);
    }
  });

  app.post("/fleet/import", async (ctx) => {
    try {
      return ctx.json(store.importControllers(importInputs(await parseJsonObjectBody(ctx))));
    } catch (error) {
      return mapBadRequest(error);
    }
  });

  app.get("/fleet/status", async (ctx) => {
    const timeout = timeoutMs(ctx.req.query("timeoutMs") ?? ctx.req.query("timeout_ms"));
    const [controllers, models] = await Promise.all([
      store.probeControllers(timeout),
      store.probeFleetModels(timeout),
    ]);
    store.upsertModels(models);
    return ctx.json({ checkedAt: new Date().toISOString(), controllers, models });
  });

  app.post("/fleet/status/refresh", async (ctx) => {
    const [controllers, models] = await Promise.all([
      store.probeControllers(5000),
      store.probeFleetModels(5000),
    ]);
    store.upsertModels(models);
    return ctx.json({ checkedAt: new Date().toISOString(), controllers, models });
  });

  app.get("/fleet/models", (ctx) => ctx.json(store.listModels()));
};
