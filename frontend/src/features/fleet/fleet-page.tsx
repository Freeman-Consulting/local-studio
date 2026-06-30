"use client";

import { FormEvent, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import api from "@/lib/api/client";
import type {
  FleetController,
  FleetControllerInput,
  FleetControllerRole,
  FleetControllerStatusResult,
  FleetModelEntry,
  FleetRoute,
  FleetRouteCapability,
  FleetRouteInput,
} from "@/lib/types";
import { AppPage, Button, Card, Input, PageHeader, StatusDot, StatusPill } from "@/ui";
import { Network, RefreshCw, Trash2 } from "@/ui/icon-registry";

const roleOptions: FleetControllerRole[] = [
  "control-plane",
  "inference",
  "specialist",
  "operator-client",
];

const capabilityOptions: FleetRouteCapability[] = ["chat", "embeddings", "vision", "audio"];

type FleetState = {
  controllers: FleetController[];
  routes: FleetRoute[];
  statuses: FleetControllerStatusResult[];
  models: FleetModelEntry[];
  checkedAt: string | null;
};

const emptyFleetState = (): FleetState => ({
  controllers: [],
  routes: [],
  statuses: [],
  models: [],
  checkedAt: null,
});

const assistantText = (payload: Record<string, unknown>): string => {
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return JSON.stringify(payload);
  const first = choices[0];
  if (!first || typeof first !== "object") return JSON.stringify(payload);
  const message = (first as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return JSON.stringify(payload);
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : JSON.stringify(payload);
};

const statusTone = (
  status: FleetControllerStatusResult["status"],
): "good" | "warning" | "danger" => {
  if (status === "online") return "good";
  if (status === "degraded") return "warning";
  return "danger";
};

const controllerStatus = (
  controller: FleetController,
  statuses: FleetControllerStatusResult[],
): FleetControllerStatusResult | null =>
  statuses.find((status) => status.controllerId === controller.id) ?? null;

const getFleetSnapshot = (): number => 0;

export default function FleetPage() {
  const [state, setState] = useState<FleetState>(emptyFleetState);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [testingRouteId, setTestingRouteId] = useState<string | null>(null);
  const [routeTestResult, setRouteTestResult] = useState<{ routeId: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FleetControllerInput>({
    url: "",
    name: "",
    role: "inference",
    apiKey: "",
    notes: "",
  });
  const [routeForm, setRouteForm] = useState<FleetRouteInput>({
    name: "",
    controllerId: "",
    modelId: "",
    endpointUrl: "",
    enabled: true,
    tags: [],
    capabilities: ["chat"],
    trustLevel: "",
    disruptionCost: "",
    defaultParams: {},
    notes: "",
  });

  const modelsByController = useMemo(
    () =>
      state.controllers
        .map((controller) => {
          const reportedModels = state.models.filter(
            (model) => model.controllerId === controller.id,
          );
          const reportedModelIds = new Set(reportedModels.map((model) => model.modelId));
          const routeModels = state.routes
            .filter(
              (route) =>
                route.controllerId === controller.id && !reportedModelIds.has(route.modelId),
            )
            .map((route) => ({
              id: `${controller.id}:${route.modelId}:route:${route.id}`,
              controllerId: controller.id,
              controllerName: controller.name,
              modelId: route.modelId,
              backend: `route ${route.name}`,
              checkedAt: route.updatedAt,
            }));
          return {
            controller,
            status: controllerStatus(controller, state.statuses),
            models: [...reportedModels, ...routeModels],
          };
        })
        .filter((group) => group.models.length > 0),
    [state.controllers, state.models, state.routes, state.statuses],
  );

  const onlineCount = useMemo(
    () => state.statuses.filter((status) => status.status === "online").length,
    [state.statuses],
  );

  const loadFleet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [controllers, routes, status] = await Promise.all([
        api.getFleetControllers(),
        api.getFleetRoutes(),
        api.getFleetStatus(1500),
      ]);
      setState({
        controllers,
        routes,
        statuses: status.controllers,
        models: status.models,
        checkedAt: status.checkedAt,
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useSyncExternalStore(
    useCallback(
      (_notify: () => void) => {
        void loadFleet();
        return () => {};
      },
      [loadFleet],
    ),
    getFleetSnapshot,
    getFleetSnapshot,
  );

  const saveController = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createFleetController({
        url: form.url,
        name: form.name || undefined,
        role: form.role,
        apiKey: form.apiKey || undefined,
        notes: form.notes || undefined,
      });
      setForm({ url: "", name: "", role: "inference", apiKey: "", notes: "" });
      await loadFleet();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const deleteController = async (controller: FleetController) => {
    setError(null);
    try {
      await api.deleteFleetController(controller.id);
      await loadFleet();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const saveRoute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingRoute(true);
    setError(null);
    try {
      await api.createFleetRoute({
        ...routeForm,
        name: routeForm.name,
        controllerId: routeForm.controllerId,
        modelId: routeForm.modelId,
        endpointUrl: routeForm.endpointUrl || undefined,
        tags: routeForm.tags,
        capabilities: routeForm.capabilities,
        trustLevel: routeForm.trustLevel || undefined,
        disruptionCost: routeForm.disruptionCost || undefined,
        notes: routeForm.notes || undefined,
      });
      setRouteForm({
        name: "",
        controllerId: "",
        modelId: "",
        endpointUrl: "",
        enabled: true,
        tags: [],
        capabilities: ["chat"],
        trustLevel: "",
        disruptionCost: "",
        defaultParams: {},
        notes: "",
      });
      await loadFleet();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSavingRoute(false);
    }
  };

  const deleteRoute = async (route: FleetRoute) => {
    setError(null);
    try {
      await api.deleteFleetRoute(route.id);
      await loadFleet();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const testRoute = async (route: FleetRoute) => {
    setError(null);
    setRouteTestResult(null);
    setTestingRouteId(route.id);
    try {
      const response = await api.runFleetRouteChatCompletion(route.name, {
        messages: [{ role: "user", content: "Reply with exactly: fleet route online" }],
        temperature: 0,
        max_tokens: 12,
      });
      setRouteTestResult({ routeId: route.id, text: assistantText(response) });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setTestingRouteId(null);
    }
  };

  return (
    <AppPage className="px-4 py-5 md:px-6 lg:px-8">
      <PageHeader
        eyebrow="Fleet control plane"
        title="Fleet machines"
        status={
          <div className="flex items-center gap-2">
            <StatusPill tone={onlineCount > 0 ? "good" : "default"} variant="badge">
              {onlineCount}/{state.controllers.length} online
            </StatusPill>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void loadFleet()}
              disabled={loading}
            >
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              Refresh
            </Button>
          </div>
        }
      />

      {error ? (
        <div className="mb-4 rounded-md border border-(--danger)/40 bg-(--danger)/10 px-3 py-2 text-[length:var(--fs-sm)] text-(--danger)">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card padding="sm" className="overflow-hidden">
            <div className="border-b border-(--border)/60 px-4 py-3">
              <div className="flex items-center gap-2 text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                <Network className="h-4 w-4 text-(--color-sky-400)" />
                Registered machine controllers
              </div>
              <p className="mt-1 text-[length:var(--fs-sm)] text-(--dim)">
                This list is stored in the control-plane SQLite database, not in this browser.
              </p>
            </div>
            <div className="divide-y divide-(--border)/45">
              {state.controllers.length === 0 ? (
                <div className="px-4 py-8 text-[length:var(--fs-sm)] text-(--dim)">
                  No machine controllers are registered yet. Add mac-mini-llm, main-llm, or gn100.
                </div>
              ) : (
                state.controllers.map((controller) => {
                  const status = controllerStatus(controller, state.statuses);
                  return (
                    <div
                      key={controller.id}
                      className="grid gap-3 px-4 py-3 lg:grid-cols-[1fr_auto]"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusDot tone={status ? statusTone(status.status) : "default"} />
                          <span className="truncate text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                            {controller.name || controller.url}
                          </span>
                          <StatusPill
                            tone={status ? statusTone(status.status) : "default"}
                            variant="badge"
                          >
                            {status?.status ?? "unknown"}
                          </StatusPill>
                          <StatusPill tone="default" variant="badge">
                            {controller.role}
                          </StatusPill>
                          {controller.hasApiKey ? (
                            <StatusPill tone="warning" variant="badge">
                              api key stored
                            </StatusPill>
                          ) : null}
                        </div>
                        <div className="mt-1 truncate font-mono text-[length:var(--fs-sm)] text-(--dim)">
                          {controller.url}
                        </div>
                        <div className="mt-2 grid gap-2 text-[length:var(--fs-sm)] text-(--dim) sm:grid-cols-3">
                          <span>
                            Latency: {status?.latencyMs == null ? "—" : `${status.latencyMs} ms`}
                          </span>
                          <span>Model: {status?.activeModel || "none"}</span>
                          <span>Backend: {status?.backend || "none"}</span>
                        </div>
                        {status?.error ? (
                          <div className="mt-2 text-[length:var(--fs-sm)] text-(--danger)">
                            {status.error}
                          </div>
                        ) : null}
                        {controller.notes ? (
                          <div className="mt-2 text-[length:var(--fs-sm)] text-(--dim)">
                            {controller.notes}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-start justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void deleteController(controller)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          <Card padding="sm" className="overflow-hidden">
            <div className="border-b border-(--border)/60 px-4 py-3">
              <div className="text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                Route aliases
              </div>
              <p className="mt-1 text-[length:var(--fs-sm)] text-(--dim)">
                Operator-facing names for machine/model lanes. Each route can target a specific
                model endpoint on its machine.
              </p>
            </div>
            <div className="divide-y divide-(--border)/45">
              {state.routes.length === 0 ? (
                <div className="px-4 py-6 text-[length:var(--fs-sm)] text-(--dim)">
                  No route aliases yet. Add one after registering a controller.
                </div>
              ) : (
                state.routes.map((route) => (
                  <div key={route.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                          {route.name}
                        </span>
                        <StatusPill tone={route.enabled ? "good" : "default"} variant="badge">
                          {route.enabled ? "enabled" : "disabled"}
                        </StatusPill>
                        {route.trustLevel ? (
                          <StatusPill tone="info" variant="badge">
                            {route.trustLevel}
                          </StatusPill>
                        ) : null}
                        {route.disruptionCost ? (
                          <StatusPill tone="warning" variant="badge">
                            {route.disruptionCost}
                          </StatusPill>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-[length:var(--fs-sm)] text-(--dim)">
                        {route.controllerName || route.controllerUrl} · {route.modelId} ·{" "}
                        {route.endpointUrl || route.controllerUrl}
                      </div>
                      {route.tags.length > 0 || route.capabilities.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {route.capabilities.map((capability) => (
                            <StatusPill key={capability} tone="info" variant="badge">
                              {capability}
                            </StatusPill>
                          ))}
                          {route.tags.map((tag) => (
                            <StatusPill key={tag} tone="default" variant="badge">
                              {tag}
                            </StatusPill>
                          ))}
                        </div>
                      ) : null}
                      {route.notes ? (
                        <div className="mt-2 text-[length:var(--fs-sm)] text-(--dim)">
                          {route.notes}
                        </div>
                      ) : null}
                      <div className="mt-2 rounded border border-(--border)/50 bg-(--surface-muted)/40 px-2 py-1.5 font-mono text-[length:var(--fs-xs)] text-(--dim)">
                        POST /fleet/routes/{route.name}/v1/chat/completions
                      </div>
                      {routeTestResult?.routeId === route.id ? (
                        <div className="mt-2 rounded border border-(--success)/35 bg-(--success)/10 px-2 py-1.5 text-[length:var(--fs-sm)] text-(--fg)">
                          {routeTestResult.text}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-start justify-end gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void testRoute(route)}
                        disabled={
                          !route.enabled ||
                          !route.capabilities.includes("chat") ||
                          testingRouteId === route.id
                        }
                      >
                        {testingRouteId === route.id ? "Testing…" : "Test"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void deleteRoute(route)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card padding="sm" className="overflow-hidden">
            <div className="border-b border-(--border)/60 px-4 py-3">
              <div className="text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                Models by controller
              </div>
              <p className="mt-1 text-[length:var(--fs-sm)] text-(--dim)">
                Grouped by machine controller. Models are populated from registered/probed endpoints
                and route aliases.
              </p>
            </div>
            <div className="divide-y divide-(--border)/45">
              {modelsByController.length === 0 ? (
                <div className="px-4 py-6 text-[length:var(--fs-sm)] text-(--dim)">
                  No fleet models reported yet.
                </div>
              ) : (
                modelsByController.map(({ controller, models, status }) => (
                  <details key={controller.id} open className="group px-4 py-3">
                    <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-(--surface-muted)/40 [&::-webkit-details-marker]:hidden">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-block text-[length:var(--fs-sm)] text-(--dim) group-open:rotate-90">
                            ▸
                          </span>
                          <StatusDot tone={status ? statusTone(status.status) : "default"} />
                          <span className="text-[length:var(--fs-lg)] font-semibold text-(--fg)">
                            {controller.name || "Unnamed controller"}
                          </span>
                          <StatusPill tone="default" variant="badge">
                            {controller.role}
                          </StatusPill>
                          <StatusPill
                            tone={status ? statusTone(status.status) : "default"}
                            variant="badge"
                          >
                            {status?.status ?? "unknown"}
                          </StatusPill>
                        </div>
                        <div className="mt-1 break-all font-mono text-[length:var(--fs-xs)] text-(--dim)">
                          {controller.url}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[length:var(--fs-xs)] text-(--dim)">
                        {models.length} {models.length === 1 ? "model" : "models"}
                      </div>
                    </summary>
                    <div className="mt-2 overflow-hidden rounded-md border border-(--border)/45">
                      {models.map((model) => (
                        <div
                          key={model.id}
                          className="grid gap-2 border-b border-(--border)/35 px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <div className="min-w-0 font-mono text-[length:var(--fs-sm)] text-(--fg)">
                            {model.modelId}
                          </div>
                          <div className="text-[length:var(--fs-xs)] text-(--dim) sm:text-right">
                            {model.backend || "unknown backend"} · checked {model.checkedAt}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="h-fit">
            <div className="mb-3 text-[length:var(--fs-lg)] font-semibold text-(--fg)">
              Add controller
            </div>
            <form onSubmit={saveController} className="space-y-3">
              <Input
                value={form.url}
                onChange={(event) =>
                  setForm((current) => ({ ...current, url: event.target.value }))
                }
                placeholder="http://main-llm.tail0c73a2.ts.net:8081"
                required
              />
              <Input
                value={form.name ?? ""}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="main-llm"
              />
              <select
                value={form.role ?? "inference"}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    role: event.target.value as FleetControllerRole,
                  }))
                }
                className="h-9 w-full rounded-md border border-(--border) bg-(--surface) px-3 text-[length:var(--fs-sm)] text-(--fg)"
              >
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <Input
                value={form.apiKey ?? ""}
                onChange={(event) =>
                  setForm((current) => ({ ...current, apiKey: event.target.value }))
                }
                placeholder="optional controller API key"
                type="password"
              />
              <Input
                value={form.notes ?? ""}
                onChange={(event) =>
                  setForm((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="notes"
              />
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? "Adding…" : "Add to shared registry"}
              </Button>
            </form>
            <div className="mt-4 rounded-md border border-(--border)/60 bg-(--surface-muted)/30 p-3 text-[length:var(--fs-sm)] text-(--dim)">
              The controller API still lives on port 8081 here. The user-facing surface is this
              frontend on port 3000.
            </div>
            {state.checkedAt ? (
              <div className="mt-3 text-[length:var(--fs-xs)] text-(--dim)">
                Last checked {state.checkedAt}
              </div>
            ) : null}
          </Card>

          <Card className="h-fit">
            <div className="mb-3 text-[length:var(--fs-lg)] font-semibold text-(--fg)">
              Add route alias
            </div>
            <form onSubmit={saveRoute} className="space-y-3">
              <Input
                value={routeForm.name}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="main-qwen27"
                required
              />
              <select
                value={routeForm.controllerId}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, controllerId: event.target.value }))
                }
                className="h-9 w-full rounded-md border border-(--border) bg-(--surface) px-3 text-[length:var(--fs-sm)] text-(--fg)"
                required
              >
                <option value="">Select controller</option>
                {state.controllers.map((controller) => (
                  <option key={controller.id} value={controller.id}>
                    {controller.name || controller.url}
                  </option>
                ))}
              </select>
              <Input
                value={routeForm.modelId}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, modelId: event.target.value }))
                }
                placeholder="qwen27"
                required
              />
              <Input
                value={routeForm.endpointUrl ?? ""}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, endpointUrl: event.target.value }))
                }
                placeholder="model endpoint URL, defaults to selected machine URL"
              />
              <div className="space-y-1.5 rounded-md border border-(--border)/60 bg-(--surface-muted)/20 p-2">
                <div className="font-mono text-[length:var(--fs-2xs)] uppercase tracking-[0.16em] text-(--dim)">
                  Capabilities
                </div>
                <div className="flex flex-wrap gap-2">
                  {capabilityOptions.map((capability) => (
                    <label
                      key={capability}
                      className="inline-flex items-center gap-1.5 text-[length:var(--fs-sm)] text-(--fg)"
                    >
                      <input
                        type="checkbox"
                        checked={(routeForm.capabilities ?? []).includes(capability)}
                        onChange={(event) =>
                          setRouteForm((current) => {
                            const capabilities = new Set(current.capabilities ?? []);
                            if (event.target.checked) capabilities.add(capability);
                            else capabilities.delete(capability);
                            return { ...current, capabilities: [...capabilities] };
                          })
                        }
                      />
                      {capability}
                    </label>
                  ))}
                </div>
              </div>
              <Input
                value={(routeForm.tags ?? []).join(", ")}
                onChange={(event) =>
                  setRouteForm((current) => ({
                    ...current,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  }))
                }
                placeholder="daily, trusted"
              />
              <Input
                value={routeForm.trustLevel ?? ""}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, trustLevel: event.target.value }))
                }
                placeholder="trust level"
              />
              <Input
                value={routeForm.disruptionCost ?? ""}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, disruptionCost: event.target.value }))
                }
                placeholder="disruption cost"
              />
              <Button
                type="submit"
                className="w-full"
                disabled={savingRoute || state.controllers.length === 0}
              >
                {savingRoute ? "Adding…" : "Add route alias"}
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </AppPage>
  );
}
