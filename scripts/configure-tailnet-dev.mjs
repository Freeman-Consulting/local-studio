#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const controllerPort = process.env.LOCAL_STUDIO_PORT || "8081";
const frontendPort = process.env.LOCAL_STUDIO_FRONTEND_PORT || "3000";
const tailscaleBinary = existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
  ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  : "tailscale";
const status = JSON.parse(execFileSync(tailscaleBinary, ["status", "--json"], { encoding: "utf8" }));
const self = status.Self ?? {};
const dnsName = String(self.DNSName ?? "").replace(/\.$/, "");
const tailnetIp = Array.isArray(self.TailscaleIPs) ? String(self.TailscaleIPs[0] ?? "") : "";
if (!dnsName || !tailnetIp) throw new Error("Tailscale is running but did not report a MagicDNS name and Tailnet IP");
const controllerUrl = `http://${dnsName}:${controllerPort}`;
const frontendUrl = `http://${dnsName}:${frontendPort}`;
const apiKey = process.env.LOCAL_STUDIO_API_KEY || randomBytes(32).toString("base64url");

function readEnv(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((line, index, lines) => index < lines.length - 1 || line.length > 0);
}

function writeEnv(path, updates) {
  const lines = readEnv(path);
  const seen = new Set();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !line.includes("=")) return line;
    const key = line.split("=", 1)[0].trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  writeFileSync(path, `${next.join("\n")}\n`);
}

writeEnv(".env", {
  LOCAL_STUDIO_HOST: tailnetIp,
  LOCAL_STUDIO_PORT: controllerPort,
  LOCAL_STUDIO_API_KEY: apiKey,
  LOCAL_STUDIO_CORS_ORIGINS: [frontendUrl, "http://localhost:3000", "http://127.0.0.1:3000"].join(","),
  LOCAL_STUDIO_PUBLIC_BASE_URL: controllerUrl,
  LOCAL_STUDIO_MAIN_CONTROLLER_DNS: dnsName,
  LOCAL_STUDIO_MAIN_CONTROLLER_TAILSCALE_IP: tailnetIp,
});

const rootEnv = Object.fromEntries(
  readEnv(".env")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const dataDir = rootEnv.LOCAL_STUDIO_DATA_DIR || join(process.env.HOME || ".", "LocalStudio", "data");
writeEnv("frontend/.env.local", {
  BACKEND_URL: controllerUrl,
  LOCAL_STUDIO_BACKEND_URL: controllerUrl,
  LOCAL_STUDIO_API_KEY: apiKey,
  LOCAL_STUDIO_DATA_DIR: dataDir,
  NEXT_PUBLIC_BACKEND_URL: "/api/proxy",
  NEXT_PUBLIC_API_URL: "/api/proxy",
  LOCAL_STUDIO_PUBLIC_BASE_URL: frontendUrl,
  LOCAL_STUDIO_MAIN_CONTROLLER_DNS: dnsName,
  LOCAL_STUDIO_MAIN_CONTROLLER_TAILSCALE_IP: tailnetIp,
});

const settingsPath = join(dataDir, "api-settings.json");
let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch {}
settings.backendUrl = controllerUrl;
settings.apiKey = apiKey;
settings.voiceUrl ??= "";
settings.voiceModel ??= "whisper-large-v3-turbo";
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
try {
  chmodSync(settingsPath, 0o600);
} catch {}

console.log(`Tailnet DNS: ${dnsName}`);
console.log(`Tailnet IP: ${tailnetIp}`);
console.log(`Controller: ${controllerUrl}`);
console.log(`Frontend: ${frontendUrl}`);
console.log("API key written to local env/settings files");
