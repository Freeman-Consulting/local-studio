# Tailnet main-controller development

This mode makes `mac-mini-llm` the explicit main controller and exposes the operator UI over Tailscale MagicDNS instead of loopback URLs.

## Configure

```bash
npm run dev:tailnet:configure
```

The configure step reads the local Tailscale daemon and writes local-only environment/settings files:

- `.env`
- `frontend/.env.local`
- `<LOCAL_STUDIO_DATA_DIR>/api-settings.json`

It sets:

- controller bind host to the Tailscale IP
- user-facing controller URL to `http://<magicdns>:8081`
- user-facing frontend URL to `http://<magicdns>:3000`
- controller API key for non-loopback binding
- frontend proxy defaults so browser clients use `/api/proxy` and the server forwards to the tailnet controller with the API key

## Start

Terminal 1:

```bash
npm run dev:tailnet:controller
```

Terminal 2:

```bash
npm run dev:tailnet:frontend
```

Open:

```text
http://mac-mini-llm.tail0c73a2.ts.net:3000
```

## Invariants

- Browser clients are operator consoles only.
- Hermes runs on `mac-mini-llm` in the selected project cwd.
- `main-llm` and `gn100` are model/SSH/compute targets, not Hermes runtime hosts.
- Frontend browser calls should use `/api/proxy`; the frontend server forwards to the main controller over Tailscale.
- Do not expose the controller on a non-loopback address without `LOCAL_STUDIO_API_KEY`.

## Smoke checks

```bash
curl http://mac-mini-llm.tail0c73a2.ts.net:3000
curl http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/health
```

Direct controller calls require the configured API key:

```bash
curl -H "Authorization: Bearer $LOCAL_STUDIO_API_KEY" \
  http://mac-mini-llm.tail0c73a2.ts.net:8081/health
```
