import { describe, expect, test } from "bun:test";

import { createTestApp, registerControllerTestLifecycle } from "./fixtures";

registerControllerTestLifecycle();

describe("fleet controller contracts", () => {
  test("registry CRUD stores controllers server-side without exposing API keys", async () => {
    const app = await createTestApp();
    const createResponse = await app.request("/fleet/controllers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://127.0.0.1:19001/v1",
        apiKey: "secret-controller-key",
        name: "Main lane",
        role: "inference",
        notes: "daily driver",
      }),
    });
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.url).toBe("http://127.0.0.1:19001");
    expect(created.hasApiKey).toBe(true);
    expect(created.apiKey).toBeUndefined();
    expect(created.role).toBe("inference");

    const listResponse = await app.request("/fleet/controllers");
    const listed = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listed).toHaveLength(1);
    expect(listed[0].apiKey).toBeUndefined();
    expect(listed[0].hasApiKey).toBe(true);

    const updateResponse = await app.request(`/fleet/controllers/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "", enabled: false, name: "Main lane paused" }),
    });
    const updated = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updated.hasApiKey).toBe(false);
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe("Main lane paused");

    const deleteResponse = await app.request(`/fleet/controllers/${created.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    expect(await app.request(`/fleet/controllers/${created.id}`)).toHaveProperty("status", 404);
  });

  test("localStorage imports dedupe into the server registry", async () => {
    const app = await createTestApp();
    const importResponse = await app.request("/fleet/controllers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controllers: [
          { url: "http://127.0.0.1:19002", name: "Mac scout" },
          { url: "http://127.0.0.1:19002/v1", name: "Duplicate" },
        ],
      }),
    });
    const imported = await importResponse.json();

    expect(importResponse.status).toBe(200);
    expect(imported.imported).toHaveLength(1);
    expect(imported.skipped).toHaveLength(1);
    expect(imported.controllers).toHaveLength(2);

    const listResponse = await app.request("/fleet/controllers");
    const listed = await listResponse.json();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Mac scout");
  });

  test("fleet status fans out with partial failure-safe controller rows", async () => {
    const authorizationHeaders: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        authorizationHeaders.push(request.headers.get("authorization") ?? "");
        if (url.pathname === "/health") return Response.json({ status: "ok" });
        if (url.pathname === "/status") {
          return Response.json({
            running: true,
            process: { backend: "vllm", served_model_name: "qwen-main", model_path: "/models/qwen" },
          });
        }
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen-main", backend: "vllm" }] });
        return Response.json({ detail: "not found" }, { status: 404 });
      },
    });

    try {
      const app = await createTestApp();
      const onlineUrl = `http://127.0.0.1:${upstream.port}`;
      await app.request("/fleet/controllers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: onlineUrl, apiKey: "controller-secret", name: "Online" }),
      });
      await app.request("/fleet/controllers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1:9", name: "Offline" }),
      });

      const statusResponse = await app.request("/fleet/status?timeoutMs=250");
      const status = await statusResponse.json();

      expect(statusResponse.status).toBe(200);
      expect(status.controllers).toHaveLength(2);
      expect(status.controllers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Online", status: "online", activeModel: "qwen-main", backend: "vllm" }),
        expect.objectContaining({ name: "Offline", status: "offline" }),
      ]));
      expect(status.models).toEqual([
        expect.objectContaining({ controllerName: "Online", modelId: "qwen-main", backend: "vllm" }),
      ]);
      expect(authorizationHeaders).toContain("Bearer controller-secret");
    } finally {
      await upstream.stop(true);
    }
  });

  test("controller API key protects fleet mutations", async () => {
    process.env.LOCAL_STUDIO_API_KEY = "control-plane-secret";
    const app = await createTestApp();
    const unauthenticated = await app.request("/fleet/controllers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:19003" }),
    });
    const authenticated = await app.request("/fleet/controllers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer control-plane-secret" },
      body: JSON.stringify({ url: "http://127.0.0.1:19003" }),
    });

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(201);
  });

  test("route aliases CRUD map names to controllers and models", async () => {
    const app = await createTestApp();
    const controllerResponse = await app.request("/fleet/controllers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:19004", name: "Main LLM" }),
    });
    const controller = await controllerResponse.json();

    const createResponse = await app.request("/fleet/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "MAIN-QWEN27",
        controllerId: controller.id,
        modelId: "qwen27",
        tags: ["daily", "fast", "daily"],
        trustLevel: "trusted",
        disruptionCost: "low",
        defaultParams: { temperature: 0.2 },
        notes: "stable 3090 lane",
      }),
    });
    const route = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(route.name).toBe("main-qwen27");
    expect(route.controllerId).toBe(controller.id);
    expect(route.controllerName).toBe("Main LLM");
    expect(route.controllerUrl).toBe("http://127.0.0.1:19004");
    expect(route.modelId).toBe("qwen27");
    expect(route.tags).toEqual(["daily", "fast"]);
    expect(route.defaultParams).toEqual({ temperature: 0.2 });

    const duplicateResponse = await app.request("/fleet/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "main-qwen27", controllerId: controller.id, modelId: "other" }),
    });
    expect(duplicateResponse.status).toBe(400);

    const byNameResponse = await app.request("/fleet/routes/main-qwen27");
    const byName = await byNameResponse.json();
    expect(byNameResponse.status).toBe(200);
    expect(byName.id).toBe(route.id);

    const updateResponse = await app.request(`/fleet/routes/${route.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, fallbackRouteId: null, tags: ["paused"] }),
    });
    const updated = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updated.enabled).toBe(false);
    expect(updated.tags).toEqual(["paused"]);

    const listResponse = await app.request("/fleet/routes");
    const routes = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("main-qwen27");

    const deleteResponse = await app.request(`/fleet/routes/${route.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    expect(await app.request(`/fleet/routes/${route.id}`)).toHaveProperty("status", 404);
  });
});
