#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function readEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !line.includes("=")) continue;
    const [key, value] = line.split(/=(.*)/s).slice(0, 2);
    env[key.trim()] = value ?? "";
  }
  return env;
}

const localEnv = readEnv(".env");
const host = localEnv.LOCAL_STUDIO_MAIN_CONTROLLER_TAILSCALE_IP;
if (!host) throw new Error("LOCAL_STUDIO_MAIN_CONTROLLER_TAILSCALE_IP missing; run npm run dev:tailnet:configure first");
const child = spawn("npm", ["run", "dev", "--", "-H", host], {
  cwd: "frontend",
  env: { ...process.env, ...localEnv },
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
