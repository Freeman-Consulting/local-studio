# Fleet Control Plane

Local Studio can run as a shared fleet control plane when one controller is reachable from every operator workstation. For Aubrey's lab, run the control-plane controller on `mac-mini-llm` and point the workstation Mac mini and MBP at that same controller URL.

## Roles

- Control plane: the Local Studio controller that owns the fleet registry SQLite state.
- Fleet controller: a Local Studio controller or compatible controller endpoint registered under `/fleet/controllers`.
- Operator client: a browser, desktop app, or CLI pointed at the control-plane controller.

The operator clients are not the source of truth for controller lists. Browser-saved controllers are imported into the control-plane registry and then treated as a local cache for display and existing direct-controller activation.

## API smoke

```bash
CONTROL_PLANE=http://mac-mini-llm:8080
curl -fsS "$CONTROL_PLANE/fleet/controllers" | jq .
curl -fsS "$CONTROL_PLANE/fleet/status?timeoutMs=1000" | jq .
curl -fsS "$CONTROL_PLANE/fleet/models" | jq .
```

Register a controller:

```bash
curl -fsS -X POST "$CONTROL_PLANE/fleet/controllers" \
  -H 'content-type: application/json' \
  -d '{"url":"http://main-llm:8080","name":"main-llm","role":"inference"}' | jq .
```

If the control-plane controller has `LOCAL_STUDIO_API_KEY` set, include `Authorization: Bearer <key>` on every request.

## Security model

Controller API keys can be accepted on create, update, and import requests so the control plane can probe registered controllers. List, get, status, and model responses never return those stored keys; they only expose `hasApiKey`.

`/fleet/status` only fans out to URLs that are already in the server-side fleet registry. It does not replace the existing `/controllers/route/*` allowlist, and it does not create a raw arbitrary-target proxy.

## Two-workstation flow

1. Start Local Studio controller on `mac-mini-llm`.
2. Set both workstation clients to use the `mac-mini-llm` controller URL.
3. Add existing workstation-local saved controllers through the UI or import endpoint.
4. Verify the same list appears from both clients with `GET /fleet/controllers`.
5. Use `GET /fleet/status` to see online, offline, and model rows without each workstation maintaining a separate controller registry.

## Current limits

This first slice is a registry and status surface. It does not implement route aliases, fallback routing, GN100 reservation/restore automation, or server-routed direct activation by controller id. Existing direct-controller activation still relies on the browser's local credential cache when the client talks directly to a registered controller.
