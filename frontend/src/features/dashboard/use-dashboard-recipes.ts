import { useCallback, useState, useSyncExternalStore } from "react";
import api from "@/lib/api/client";
import type { ProcessInfo, RecipeWithStatus } from "@/lib/types";
import { effectInterval } from "@/lib/effect-timers";

export function useDashboardRecipes(currentProcess: ProcessInfo | null) {
  const [recipes, setRecipes] = useState<RecipeWithStatus[]>([]);
  const [currentRecipe, setCurrentRecipe] = useState<RecipeWithStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const selectTargetLogSession = useCallback(
    (
      sessions: Array<{
        id: string;
        recipe_id?: string;
        status: string;
        backend?: string;
        model_path?: string;
        model?: string;
        started_at?: string;
        created_at?: string;
      }>,
      runningRecipe: RecipeWithStatus | null,
    ) => {
      if (sessions.length === 0) return null;

      // Sort newest-first so we always prefer the most recently started session.
      const ts = (s: { started_at?: string; created_at?: string }) =>
        Date.parse(s.started_at || s.created_at || "") || 0;
      const sorted = [...sessions].sort((a, b) => ts(b) - ts(a));
      const running = sorted.filter((s) => s.status === "running");

      if (currentProcess) {
        const matches = (session: (typeof sorted)[number]) => {
          if (session.model_path && currentProcess.model_path) {
            return session.model_path === currentProcess.model_path;
          }
          if (session.model && currentProcess.served_model_name) {
            return session.model === currentProcess.served_model_name;
          }
          return session.backend === currentProcess.backend;
        };
        const byProcess = running.find(matches) || sorted.find(matches);
        if (byProcess) return byProcess;

        const servedModel = currentProcess.served_model_name?.toLowerCase();
        if (servedModel) {
          const byName = sorted.find((session) =>
            (session.id ?? "").toLowerCase().includes(servedModel),
          );
          if (byName) return byName;
        }
      }

      if (runningRecipe) {
        const byRecipe =
          running.find((s) => s.recipe_id === runningRecipe.id) ||
          sorted.find((s) => s.recipe_id === runningRecipe.id);
        if (byRecipe) return byRecipe;
      }

      // Fall back to newest running, then newest of any status.
      return running[0] || sorted[0];
    },
    [currentProcess],
  );

  const refreshLogs = useCallback(
    async (runningRecipe: RecipeWithStatus | null, limit = 220) => {
      try {
        const sessions = await api.getLogSessions();
        const list = sessions.sessions || [];
        if (list.length === 0) {
          setLogs([]);
          return;
        }
        const targetSession = selectTargetLogSession(list, runningRecipe);
        if (!targetSession) {
          setLogs([]);
          return;
        }
        const logData = await api.getLogs(targetSession.id, limit).catch(() => ({ logs: [] }));
        setLogs(logData.logs || []);
      } catch {
        setLogs([]);
      }
    },
    [selectTargetLogSession],
  );

  const reload = useCallback(async () => {
    try {
      const data = await api.getModels();
      const list = (data.models || [])
        .filter((model) => Array.isArray(model.recipe_ids) && model.recipe_ids.length > 0)
        .filter((model) => {
          const value = `${model.name} ${model.path}`.toLowerCase();
          return !value.includes("embed") && !value.includes("whisper");
        })
        .map((model): RecipeWithStatus => {
          const recipeId = model.recipe_ids?.[0] || model.name || model.path;
          const servedName = currentProcess?.served_model_name?.toLowerCase() || "";
          const modelName = model.name.toLowerCase();
          const modelPath = model.path.toLowerCase();
          const isRunning = Boolean(
            currentProcess &&
            (servedName === recipeId.toLowerCase() ||
              servedName === modelName ||
              currentProcess.model_path?.toLowerCase() === modelPath),
          );
          return {
            id: recipeId,
            name: model.name,
            model_path: model.path,
            backend: recipeId.startsWith("fleet-route-") ? "llamacpp" : "vllm",
            env_vars: null,
            tensor_parallel_size: 1,
            pipeline_parallel_size: 1,
            max_model_len: model.context_length ?? 4096,
            gpu_memory_utilization: 0.9,
            kv_cache_dtype: "auto",
            max_num_seqs: 256,
            trust_remote_code: false,
            tool_call_parser: null,
            reasoning_parser: null,
            enable_auto_tool_choice: false,
            quantization: model.quantization ?? null,
            dtype: null,
            host: "127.0.0.1",
            port: currentProcess?.port ?? 8000,
            served_model_name: model.name,
            python_path: null,
            extra_args: {
              metadata: {
                status_dropdown_model: true,
                fleet_capabilities: ["chat"],
              },
            },
            max_thinking_tokens: null,
            thinking_mode: "auto",
            status: isRunning ? "running" : "stopped",
            tp: 1,
            pp: 1,
          };
        });
      setRecipes(list);

      const running = currentProcess
        ? list.find((r: RecipeWithStatus) => r.status === "running") || null
        : null;
      setCurrentRecipe(running);
      await refreshLogs(running);
    } catch (e) {
      console.error("Failed to load status model options:", e);
    } finally {
      setLoading(false);
    }
  }, [currentProcess, refreshLogs]);

  const subscribeRecipeReload = useCallback(
    (_notify: () => void) => {
      void reload();
      return () => {};
    },
    [reload],
  );

  const subscribeRecipeEvents = useCallback(
    (_notify: () => void) => {
      const handler = () => {
        void reload();
      };
      window.addEventListener("vllm:recipe-event", handler as EventListener);
      return () => {
        window.removeEventListener("vllm:recipe-event", handler as EventListener);
      };
    },
    [reload],
  );

  const subscribeRecipeLogPolling = useCallback(
    (_notify: () => void) => {
      if (!currentProcess) return () => {};
      let cancelled = false;
      const poll = async () => {
        if (cancelled) return;
        await refreshLogs(currentRecipe);
      };
      void poll();
      const timer = effectInterval(() => void poll(), 4000);
      return () => {
        cancelled = true;
        timer.cancel();
      };
    },
    [currentProcess, currentRecipe, refreshLogs],
  );

  useSyncExternalStore(
    subscribeRecipeReload,
    getDashboardRecipesSnapshot,
    getDashboardRecipesSnapshot,
  );
  useSyncExternalStore(
    subscribeRecipeEvents,
    getDashboardRecipesSnapshot,
    getDashboardRecipesSnapshot,
  );
  useSyncExternalStore(
    subscribeRecipeLogPolling,
    getDashboardRecipesSnapshot,
    getDashboardRecipesSnapshot,
  );

  return { recipes, currentRecipe, logs, loading, reload };
}

const getDashboardRecipesSnapshot = (): number => 0;
