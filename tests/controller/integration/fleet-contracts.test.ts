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

  test("route aliases proxy OpenAI-compatible chat and model list", async () => {
    const upstreamRequests: Array<{ path: string; authorization: string; body?: Record<string, unknown> }> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization") ?? "";
        if (url.pathname === "/v1/models") {
          upstreamRequests.push({ path: url.pathname, authorization });
          return Response.json({ data: [{ id: "upstream-model" }] });
        }
        if (url.pathname === "/v1/chat/completions") {
          return request.json().then((body) => {
            upstreamRequests.push({ path: url.pathname, authorization, body: body as Record<string, unknown> });
            return Response.json({ choices: [{ message: { role: "assistant", content: "fleet online" } }] });
          });
        }
        return Response.json({ detail: "not found" }, { status: 404 });
      },
    });

    try {
      const app = await createTestApp();
      const controllerResponse = await app.request("/fleet/controllers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}`, apiKey: "route-secret", name: "Route target" }),
      });
      const controller = await controllerResponse.json();
      const routeResponse = await app.request("/fleet/routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "main",
          controllerId: controller.id,
          modelId: "served-model",
          defaultParams: { temperature: 0.1 },
        }),
      });
      const route = await routeResponse.json();

      const modelsResponse = await app.request("/fleet/routes/main/v1/models");
      const models = await modelsResponse.json();
      expect(modelsResponse.status).toBe(200);
      expect(models.data[0].id).toBe("upstream-model");

      const chatResponse = await app.request(`/fleet/routes/${route.id}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ignored-client-model", messages: [{ role: "user", content: "ping" }] }),
      });
      const chat = await chatResponse.json();

      expect(chatResponse.status).toBe(200);
      expect(chat.choices[0].message.content).toBe("fleet online");
      expect(upstreamRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/v1/models", authorization: "Bearer route-secret" }),
        expect.objectContaining({
          path: "/v1/chat/completions",
          authorization: "Bearer route-secret",
          body: expect.objectContaining({ model: "served-model", temperature: 0.1 }),
        }),
      ]));
    } finally {
      await upstream.stop(true);
    }
  });
});
