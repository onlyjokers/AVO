import type { BenchmarkSnapshot, ProviderHealth, RunConfig, RunEvent, RunSnapshot, TaskManifest, Usage } from "@avo/contracts";

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

export const api = {
  health: () => fetch("/api/provider-health").then((response) => json<ProviderHealth & { mode: string }>(response)),
  tasks: () => fetch("/api/tasks").then((response) => json<{ items: TaskManifest[] }>(response)),
  task: (id: string) => fetch(`/api/tasks/${id}`).then((response) => json<{ task: TaskManifest }>(response)),
  upload: async (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return fetch("/api/artifacts", { method: "POST", body }).then((response) => json<{ artifact: { id: string } }>(response));
  },
  createTask: (input: { title: string; request: string; source_artifact_id: string; references: Array<{ artifact_id: string; caption?: string }> }) =>
    fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
      .then((response) => json<{ task: TaskManifest }>(response)),
  runs: () => fetch("/api/runs").then((response) => json<{ items: RunSnapshot[] }>(response)),
  run: (id: string) => fetch(`/api/runs/${id}`).then((response) => json<{ run: RunSnapshot }>(response)),
  runEvents: (id: string) => fetch(`/api/runs/${id}/event-log`).then((response) => json<{ items: RunEvent[] }>(response)),
  createRun: (taskId: string, mode: RunConfig["mode"]) =>
    fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: taskId, config: { mode, max_generations: mode === "one_shot" ? 1 : 24 } }),
    }).then((response) => json<{ run: RunSnapshot }>(response)),
  stopRun: (id: string) => fetch(`/api/runs/${id}/stop`, { method: "POST" }).then((response) => json<{ run: RunSnapshot }>(response)),
  resumeRun: (id: string) => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then((response) => json<{ run: RunSnapshot }>(response)),
  deleteRun: async (id: string) => {
    const response = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    if (!response.ok) await json(response);
  },
  benchmarks: () => fetch("/api/benchmarks").then((response) => json<{ items: BenchmarkSnapshot[] }>(response)),
  createBenchmark: (taskIds: string[]) => fetch("/api/benchmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_ids: taskIds }),
  }).then((response) => json<{ benchmark: BenchmarkSnapshot }>(response)),
  benchmark: (id: string) => fetch(`/api/benchmarks/${id}`).then((response) => json<BenchmarkReport>(response)),
  concludeBenchmark: (id: string, verdict: "avo_better" | "inconclusive" | "not_better", notes: string) =>
    fetch(`/api/benchmarks/${id}/conclusion`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict, notes }),
    }).then((response) => json<{ benchmark: BenchmarkSnapshot }>(response)),
};

export type BenchmarkReport = {
  benchmark: BenchmarkSnapshot;
  rows: Array<{
    run_id: string;
    task_id: string;
    mode: RunConfig["mode"];
    status: string;
    passed: boolean;
    generation_count: number;
    verifier_count: number;
    best_score: number;
    first_pass_generation: number | null;
    total_latency_ms: number;
    usage: Usage;
    prefix_curve: Array<{ budget: number; passed: boolean; best_score: number }>;
    models: { main: string; generator: string; verifier: string };
    provider_revisions: { codex: string; generator: string; verifier: string };
    terminal_reason?: string;
  }>;
  aggregate: Array<{
    mode: string;
    tasks: number;
    passes: number;
    average_generations: number;
    average_best_score: number;
    average_latency_ms: number;
    estimated_cost_usd: number;
    unpriced: boolean;
  }>;
};

export const artifactUrl = (id: string) => `/api/artifacts/${encodeURIComponent(id)}`;
