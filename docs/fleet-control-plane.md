# Fleet Control Plane

Local Studio can run as a shared fleet control plane when the operator UI and controller API are reachable from every operator workstation. For Aubrey's lab, run the Local Studio controller and frontend on `mac-mini-llm`; browser clients on the MBP or other Macs use Tailscale MagicDNS and stay operator consoles only.

## Definitions

- Control plane process: the Local Studio server process that owns the fleet registry SQLite state. Today this runs on `mac-mini-llm`.
- Fleet controller: a machine/host in the fleet, not an individual model port. Current target controllers are `mac-mini-llm`, `main-llm`, and `gn100`.
- Model: a model/service running on a fleet controller machine.
- Route alias: an operator-facing lane that binds a fleet controller + model id + endpoint URL + default params/trust metadata. Normal shape is one route alias per model, with additional aliases allowed for tuned parameter lanes.
- Operator client: a browser, desktop app, or CLI pointed at the control-plane frontend/API.

The operator clients are not the source of truth for fleet lists. Browser calls should use `/api/proxy`; API keys stay server-side.

## API smoke

```bash
CONTROL_PLANE=http://mac-mini-llm.tail0c73a2.ts.net:8081
curl -fsS "$CONTROL_PLANE/fleet/controllers" | jq .
curl -fsS "$CONTROL_PLANE/fleet/status?timeoutMs=1000" | jq .
curl -fsS "$CONTROL_PLANE/fleet/models" | jq .
curl -fsS "$CONTROL_PLANE/fleet/routes" | jq .
```

Register a machine controller:

```bash
curl -fsS -X POST "$CONTROL_PLANE/fleet/controllers" \
  -H 'content-type: application/json' \
  -d '{"url":"http://main-llm.tail0c73a2.ts.net:8081","name":"main-llm","role":"inference"}' | jq .
```

Register a route alias for a model endpoint on that machine:

```bash
curl -fsS -X POST "$CONTROL_PLANE/fleet/routes" \
  -H 'content-type: application/json' \
  -d '{
    "name":"main-qwen27",
    "controllerId":"<main-llm-controller-id>",
    "modelId":"qwen27",
    "endpointUrl":"http://main-llm.tail0c73a2.ts.net:18008",
    "tags":["daily"]
  }' | jq .
```

If the control-plane controller has `LOCAL_STUDIO_API_KEY` set, include `Authorization: Bearer ...` on every request.

## Security model

Controller API keys can be accepted on create, update, and import requests so the control plane can probe registered controllers. List, get, status, and model responses never return those stored keys; they only expose `hasApiKey`.

Route aliases proxy OpenAI-compatible calls through server-side stored credentials. `/fleet/routes/:route/v1/models` and `/fleet/routes/:route/v1/chat/completions` target the route's `endpointUrl` when set, otherwise they fall back to the machine controller URL for backwards compatibility. Browser clients should reach those routes through `/api/proxy`.

`/fleet/status` only fans out to URLs that are already in the server-side fleet registry. It does not replace the existing `/controllers/route/*` allowlist, and it does not create a raw arbitrary-target proxy.

## Two-workstation flow

1. Start Local Studio controller and frontend on `mac-mini-llm`.
2. Point workstation clients at `http://mac-mini-llm.tail0c73a2.ts.net:3000`.
3. Register host-level fleet controllers: `mac-mini-llm`, `main-llm`, and `gn100`.
4. Register route aliases for individual model endpoints on those machines.
5. Verify the same controller/model/route list appears from both clients.
6. Use `GET /fleet/status` and the Fleet page to see online/offline machines and grouped models.

## Current limits

Fleet now separates machine controllers from route endpoint URLs, but model discovery still depends on what each registered machine URL exposes at `/v1/models` plus models implied by route aliases. A later slice should add explicit model/service endpoint records if we need richer per-machine discovery across many ports without relying on routes as the inventory source.
