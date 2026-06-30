import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { requireApiAccess } from "@/lib/auth/guard";
import { errorMessage, jsonError } from "@/app/api/_lib/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

type HermesTurnBody = {
  message?: unknown;
  cwd?: unknown;
  profile?: unknown;
};

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function cleanHermesOutput(value: string): string {
  const lines = stripAnsi(value)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[─│]/g, "").trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Query:"))
    .filter((line) => line !== "Initializing agent...")
    .filter((line) => !line.startsWith("⚕ Hermes"))
    .filter((line) => !line.startsWith("Resume this session with:"))
    .filter((line) => !line.startsWith("hermes --resume "))
    .filter((line) => !line.startsWith("Session:"))
    .filter((line) => !line.startsWith("Duration:"))
    .filter((line) => !line.startsWith("Messages:"));
  return lines.join("\n").trim();
}

function runHermes({
  message,
  cwd,
  profile,
}: {
  message: string;
  cwd: string;
  profile: string;
}): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", profile, "chat", "-q", message];
    const child = spawn("hermes", args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", HERMES_NO_TUI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Hermes turn timed out"));
    }, DEFAULT_TIMEOUT_MS);
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_BYTES) output = output.slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ text: cleanHermesOutput(output), exitCode });
    });
  });
}

export async function POST(request: NextRequest) {
  const denied = requireApiAccess(request);
  if (denied) return denied;
  let body: HermesTurnBody;
  try {
    body = (await request.json()) as HermesTurnBody;
  } catch {
    return jsonError("Invalid JSON body");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const profile =
    typeof body.profile === "string" && body.profile.trim() ? body.profile.trim() : "default";
  if (!message) return jsonError("message is required");
  if (!cwd || !isAbsolutePath(cwd)) return jsonError("absolute cwd is required");
  try {
    const result = await runHermes({ message, cwd, profile });
    return Response.json({
      type: "hermes_turn",
      profile,
      cwd,
      exitCode: result.exitCode,
      text: result.text,
      ok: result.exitCode === 0,
    });
  } catch (error) {
    return Response.json({ error: errorMessage(error, "Hermes turn failed") }, { status: 500 });
  }
}
