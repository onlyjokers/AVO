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
  uploadSealed: async (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return fetch("/api/sealed-uploads", { method: "POST", body })
      .then((response) => json<{ upload_token: string; expires_at: string }>(response));
  },
  createTask: (input: {
    title: string;
    user_brief: string;
    source_artifact_id: string;
    references: Array<{ artifact_id: string; caption?: string }>;
    preservation_contract?: Record<string, unknown>;
    hidden_references?: Array<{ upload_token: string; caption?: string }>;
    hidden_target_token?: string;
    private_rubric?: string;
  }) =>
    fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
      .then((response) => json<{ task: TaskManifest }>(response)),
  evaluatorInputs: (id: string) => fetch(`/api/tasks/${id}/evaluator-inputs`)
    .then((response) => json<{ evaluator_inputs: EvaluatorInputSummary }>(response)),
  runs: () => fetch("/api/runs").then((response) => json<{ items: RunSnapshot[] }>(response)),
  run: (id: string) => fetch(`/api/runs/${id}`).then((response) => json<{ run: RunSnapshot }>(response)),
  evaluatorResults: (id: string) => fetch(`/api/runs/${id}/evaluator-results`).then((response) => json<EvaluatorResults>(response)),
  runEvents: (id: string) => fetch(`/api/runs/${id}/event-log`).then((response) => json<{ items: RunEvent[] }>(response)),
  modelProfiles: () => fetch("/api/model-profiles").then((response) => json<{ defaults: NonNullable<RunConfig["role_profiles"]>; options: Array<{ id: "qwen" | "78code"; model: string; configured: boolean }> }>(response)),
  createRun: (taskId: string, mode: RunConfig["mode"], roleProfiles?: RunConfig["role_profiles"], features?: RunConfig["experimental_features"]) =>
    fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: taskId, config: { mode, max_generations: mode === "one_shot" ? 1 : 24, role_profiles: roleProfiles, ...(features ? { experimental_features: features } : {}) } }),
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
    final_version: number;
    final_node_id: string | null;
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
export const evaluatorAssetUrl = (taskId: string, slot: string) => `/api/tasks/${taskId}/evaluator-assets/${slot}`;

export type EvaluatorInputSummary = {
  has_hidden_evaluation: boolean;
  reference_count: number;
  has_hidden_target: boolean;
  has_private_rubric: boolean;
  references?: Array<{ index: number; original_name: string; caption: string }>;
  hidden_target_name?: string | null;
  private_rubric?: string;
};

export type EvaluatorResults = {
  evaluation_frames: RunSnapshot["evaluation_frame_revisions"];
  comparative_decisions: RunSnapshot["comparative_decisions"];
  final_decisions: RunSnapshot["final_verifier_decisions"];
  quality_measurements: Array<{
    evaluation_id: string;
    draft_id: string;
    source_quality_debt: RunSnapshot["evaluations"][number]["source_quality_debt"];
    step_quality_debt: RunSnapshot["evaluations"][number]["step_quality_debt"];
    validator_elapsed_ms?: number;
  }>;
};
