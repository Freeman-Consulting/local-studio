# Local Studio Fleet Control Plane Handoff

Last updated: 2026-06-30
Branch: `feat/fleet-control-plane`
Repo checkout: `/Users/openclaw/.hermes/projects/local-studio-fleet-control-plane/worktrees/local-studio`

## Current product direction

Local Studio is being turned into a server-side fleet/control-plane product, not just a local model launcher.

Target architecture:

```text
Browser clients on MBP / other Macs
  -> Tailscale MagicDNS frontend on mac-mini-llm
  -> frontend /api/proxy
  -> Local Studio controller on mac-mini-llm
  -> Hermes runtime on mac-mini-llm in selected project cwd
  -> model / SSH / compute targets on mac-mini-llm, main-llm, gn100
```

Hard invariants:

- `mac-mini-llm` is the main controller host.
- Hermes runs only on `mac-mini-llm`.
- `main-llm` and `gn100` are inference / SSH / compute targets, not Hermes runtime hosts.
- Browser clients are operator consoles only.
- Remote browser access must use Tailscale MagicDNS, not client-local `127.0.0.1`, `.local`, or LAN assumptions.
- Controller access outside loopback stays API-key protected.
- API keys must stay server-side; browser calls should go through `/api/proxy`.

## Current live URLs

Use these from Tailnet clients:

```text
Frontend / operator UI:
http://mac-mini-llm.tail0c73a2.ts.net:3000

Controller API, protected:
http://mac-mini-llm.tail0c73a2.ts.net:8081
```

Important: the frontend dev server may print this bind URL:

```text
http://100.103.183.103:3000
```

That is only the Tailnet bind address. Use MagicDNS in the browser.

## Current verification status

Latest HTTP probes from this session passed:

```text
GET http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/health
-> 200 {"status":"ok"}

GET http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/fleet/controllers
-> 200

GET http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/fleet/status?timeoutMs=1500
-> 200
```

Latest full gate passed:

```bash
export PATH="$HOME/.bun/bin:$PATH"
npm run check
```

Known non-blocking warning remains:

```text
frontend/src/lib/desktop-ui-preferences.ts
Function 'mergeControllersPreference' has complexity 26. Maximum allowed is 20.
```

This is a warning, not a failing error.

## Recent commits on this branch

```text
54687001 refactor(fleet): make model groups collapsible
d8f2c457 fix(fleet): group models by controller
79ae7633 feat(dev): add tailnet main controller mode
e66e8b51 feat(agent): add Hermes runtime option
0c0210cb feat(fleet): proxy route aliases
1a005597 fix(fleet): keep inference endpoints out of status controller switcher
3598eaac feat(fleet): add route aliases
cc5f9e59 fix(agent): cache session prefs server snapshot
779d8804 feat(fleet): add fleet operator page
```

## What is done

### Fleet registry and operator page

Fleet has a shared controller registry backed by the control-plane SQLite database.

The `/fleet` page now shows:

- registered controllers
- per-controller health/status
- route aliases
- models grouped by controller
- add/delete controller forms
- add/delete route alias forms
- route alias smoke test button

### Models by controller

Current implementation:

- Models are grouped under their owning controller.
- Each controller group is collapsible.
- Controller name is the primary label.
- Controller URL/IP is secondary muted metadata.
- Each group shows role, online status, model count, and model IDs.
- Groups default open.
- Browser smoke verified that clicking the group summary collapses the model list.

Primary file:

```text
frontend/src/features/fleet/fleet-page.tsx
```

### Route aliases

Route aliases exist as operator-facing lanes for model endpoints.

Implemented endpoints:

```text
GET  /fleet/routes/:route/v1/models
POST /fleet/routes/:route/v1/chat/completions
```

Behavior:

- resolve route by id or name
- disabled route returns `409`
- missing route returns `404`
- route enforces configured `modelId`
- route merges default params
- controller API key is forwarded server-side only
- browser never receives upstream API keys

A known live route exists:

```text
mac-local -> qwen25-05b
```

Local browser proxy path:

```text
/api/proxy/fleet/routes/mac-local/v1/chat/completions
```

Controller direct path:

```text
/fleet/routes/mac-local/v1/chat/completions
```

### Status page endpoint filtering

The Status page no longer treats raw inference endpoints as Local Studio control-plane backends.

Only `role === "control-plane"` entries participate in Status backend switching. Raw llama.cpp / MLX / specialist endpoints remain visible and manageable in Fleet.

Key files:

```text
frontend/src/lib/api/controllers.ts
frontend/src/features/dashboard/control-panel/control-panel-v2.tsx
```

### Tailnet main-controller mode

A Tailnet dev configuration flow exists:

```bash
npm run dev:tailnet:configure
npm run dev:tailnet:controller
npm run dev:tailnet:frontend
```

Current intended env shape:

- user-facing frontend: `http://mac-mini-llm.tail0c73a2.ts.net:3000`
- user-facing controller: `http://mac-mini-llm.tail0c73a2.ts.net:8081`
- private frontend proxy target: `http://127.0.0.1:8081`
- controller is API-key protected for non-loopback access

The private loopback proxy target is intentional. The frontend server is co-located with the controller on `mac-mini-llm`, so it should not self-call the controller through Tailnet/MagicDNS. Remote browsers still use MagicDNS and `/api/proxy`.

Key files:

```text
scripts/configure-tailnet-dev.mjs
scripts/start-tailnet-frontend.mjs
docs/tailnet-main-controller.md
frontend/next.config.ts
frontend/src/instrumentation.ts
```

### Hermes runtime option

New Chat has a runtime selector with Pi and Hermes.

Current Hermes slice:

- adds `/api/agent/hermes/turn`
- spawns real Hermes from selected project cwd
- Pi remains default
- Hermes response renders in the transcript
- browser smoke previously verified exact output: `hermes ui visible`

Key files:

```text
frontend/src/app/api/agent/hermes/turn/route.ts
frontend/src/features/agent/runtime/types.ts
frontend/src/features/agent/runtime/api.ts
frontend/src/features/agent/runtime/prompt-stream.ts
frontend/src/features/agent/ui/chat-pane.tsx
frontend/src/features/agent/ui/agent-chat-pane-header.tsx
frontend/src/features/agent/ui/agent-workspace-shell.tsx
```

Current Hermes limitations:

- one-shot per prompt
- profile fixed to `default`
- no persistent/resumed Hermes session yet
- no structured tool-call event rendering yet
- abort does not kill spawned Hermes process yet

## Runtime/process notes

If Tailnet UI starts acting stale or Fleet shows HTTP 500s again, first do a clean dev-server restart.

From repo root:

```bash
pkill -f "node scripts/start-tailnet-frontend.mjs"
pkill -f "next dev -H 100.103.183.103"
pkill -f "bun src/main.ts"

node scripts/configure-tailnet-dev.mjs

export PATH="$HOME/.bun/bin:$PATH"
npm run dev:tailnet:controller
```

In a second terminal:

```bash
cd /Users/openclaw/.hermes/projects/local-studio-fleet-control-plane/worktrees/local-studio
npm run dev:tailnet:frontend
```

Then verify:

```bash
curl http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/health
```

Expected:

```json
{"status":"ok"}
```

Do not trust delayed Hermes background-process watch notifications by themselves. Verify live with process status/logs and HTTP probes.

## Known live fleet inventory

Registered endpoints observed in Fleet include:

```text
mac-mini-llm local control plane -> http://mac-mini-llm.tail0c73a2.ts.net:8081
qwen35-9b-llamacpp             -> http://127.0.0.1:11436
nomic-embed-llamacpp           -> http://127.0.0.1:11437
mlx-qwen36-35b                 -> http://127.0.0.1:11450
mlx-vlm-qwen3-vl               -> http://127.0.0.1:11453
mlx-whisper                    -> http://127.0.0.1:11454
qwen36-27b-mtp-llamacpp        -> http://127.0.0.1:18008
qwen36-27b-mtp-alt             -> http://127.0.0.1:18082
```

These are currently local to `mac-mini-llm`. Future work should register real remote `main-llm` and `gn100` endpoints with explicit host identity once their OpenAI-compatible or telemetry endpoints are confirmed.

## Next steps

### 1. Add active route selection for New Chat

Goal: New Chat should select a route/lane, not a raw model port.

Expected UX:

```text
Project: <cwd/project>
Runtime: Pi | Hermes
Route: mac-local | main-qwen27 | gn100-fast | ...
```

Implementation outline:

- Add `Use route` button on Fleet route cards.
- Persist active route, likely in local storage or session state:
  ```text
  local-studio.activeFleetRoute = <route-name-or-id>
  ```
- Show active route in chat header.
- Thread selected route into agent/model calls where appropriate.
- Keep route as metadata for Hermes initially; do not pretend Hermes can route models until the Hermes invocation supports model override.
- For direct model chat paths, call:
  ```text
  /api/proxy/fleet/routes/:route/v1/chat/completions
  ```

### 2. Promote Hermes runtime from one-shot to resumable sessions

Goal: match Aubrey's terminal habit:

```bash
cd <project>
hermes
```

Needed:

- preserve Hermes session id from CLI output
- resume follow-up turns with `hermes --resume <id>` or an interactive subprocess adapter
- add profile selector:
  ```text
  default | wren | sloane | vega | ...
  ```
- implement abort/kill for spawned Hermes process
- render structured tool events if available

### 3. Register real remote infrastructure targets

Goal: represent `main-llm` and `gn100` as real Fleet nodes, not just local endpoints.

Needed:

- confirm reachable OpenAI-compatible model endpoints for each host over Tailnet/MagicDNS
- add controller/node records with human names:
  ```text
  main-llm
  gn100
  ```
- avoid IP address as primary identifier
- capture role:
  ```text
  inference | specialist | ssh-target | compute
  ```
- add notes/metadata explaining what each target is good for

### 4. Improve Fleet model grouping further

Current grouping is functional. Next polish:

- remember collapsed/open state per controller
- show model aliases or route names alongside raw model ids
- indicate whether a model is attached to any route alias
- add `Create route from model` action under each model row

### 5. Clean up outstanding warning

Non-blocking but worth fixing:

```text
frontend/src/lib/desktop-ui-preferences.ts
mergeControllersPreference complexity 26 > 20
```

This is not blocking, but it is now recurring noise in every check output.

## Suggested first command in the next session

```bash
cd /Users/openclaw/.hermes/projects/local-studio-fleet-control-plane/worktrees/local-studio
git status --short --branch
curl http://mac-mini-llm.tail0c73a2.ts.net:3000/api/proxy/health
```

If health is good, continue with route selection for New Chat.

If health fails, perform the clean Tailnet restart sequence in the Runtime/process notes section.
