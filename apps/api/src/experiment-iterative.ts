import { referenceUsageSchema, type RunSnapshot } from "@avo/contracts";
import type { AgentToolbox, ImagePoolItem } from "@avo/core";
import { z } from "zod";

const name = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(8_000);
const generation = {
  trajectory: name,
  prompt: text,
  rationale: text,
  reference_artifact_ids: z.array(z.string().min(1)).max(24).default([]),
  reference_usage: z.array(referenceUsageSchema).max(24).optional(),
  override_rationale: text.optional(),
};

export const iterativeActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("FRESH_START"), ...generation, strategy: text }).strict(),
  z.object({ action: z.literal("CONTINUE"), ...generation }).strict(),
  z.object({ action: z.literal("BACKTRACK"), ...generation, base_artifact_id: z.string().min(1) }).strict(),
  z.object({ action: z.literal("ADOPT"), trajectory: name, draft_id: z.string().min(1), rationale: text }).strict(),
  z.object({ action: z.literal("STOP"), trajectory: name, rationale: text, scope: z.enum(["trajectory", "search"]).default("trajectory") }).strict(),
]);
export type IterativeAction = z.infer<typeof iterativeActionSchema>;
export const iterativeWireSchema = z.union([z.string().describe("A JSON-encoded action object; use this form if nested object serialization fails."), iterativeActionSchema]);
export const parseIterativeAction = (input: unknown): IterativeAction =>
  iterativeActionSchema.parse(typeof input === "string" ? JSON.parse(input) : input);

const historySchema = z.object({
  action: z.enum(["FRESH_START", "CONTINUE", "BACKTRACK", "STOP", "ADOPT"]),
  base_artifact_id: z.string(),
  artifact_id: z.string().optional(),
  draft_id: z.string().optional(),
  prompt: z.string().optional(),
  rationale: z.string(),
  reference_artifact_ids: z.array(z.string()),
  outcome: z.enum(["generated", "failed", "stopped", "adopted"]),
}).strict();
const trajectorySchema = z.object({
  name, strategy: text, path: z.array(z.string()).min(1),
  stopped: z.boolean(), history: z.array(historySchema),
}).strict();
export const iterativeStateSchema = z.object({
  version: z.literal(1), run_id: z.string().min(1), revision: z.number().int().nonnegative(),
  planned_starts: z.number().int().min(1).max(24),
  extra_generation_charges: z.number().int().nonnegative(),
  stopped: z.boolean(), trajectories: z.array(trajectorySchema),
  pending: z.object({ trajectory: name, action: iterativeActionSchema }).strict().optional(),
}).strict();
export type IterativeState = z.infer<typeof iterativeStateSchema>;
export type IterativeCheckpoint = {
  type: "experiment.iterative.checkpoint";
  data: { phase: "reserved" | "generated" | "failed" | "stopped" | "adopted"; state: IterativeState };
};
export type IterativeOptions = {
  enabled: boolean;
  /** Durable run-owned event write; must resolve before side effects proceed. */
  checkpoint: (event: IterativeCheckpoint) => Promise<void>;
  state?: IterativeState;
  plannedStarts?: number;
  now?: () => number;
};

export function createIterativeState(run: RunSnapshot, plannedStarts = 2): IterativeState {
  const requested = z.number().int().min(1).max(24).parse(plannedStarts);
  return {
    version: 1, run_id: run.id, revision: 0,
    planned_starts: Math.max(1, Math.min(requested, run.config.max_generations - run.generation_count)),
    extra_generation_charges: 0, stopped: false, trajectories: [],
  };
}

/** One instance per run, shared across step sessions; never accepts caller-supplied image paths. */
export class IterativeSearch {
  private state: IterativeState | undefined;
  private busy = false;
  private persistenceFailed = false;

  constructor(private readonly options: IterativeOptions) {
    this.state = options.state ? iterativeStateSchema.parse(options.state) : undefined;
  }

  snapshot(): IterativeState | undefined {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async execute(tools: AgentToolbox, input: unknown) {
    if (!this.options.enabled) throw new Error("iterative_search_disabled");
    if (this.busy) throw new Error("iterative_search_busy");
    if (this.persistenceFailed) throw new Error("iterative_checkpoint_failed_reload_required");
    this.busy = true;
    try {
      const action = parseIterativeAction(input);
      // listImagePool refreshes the real toolbox snapshot and is the visibility authority.
      const pool = await tools.listImagePool();
      const run = tools.getRunSnapshot();
      this.state ??= createIterativeState(run, this.options.plannedStarts);
      const state = this.state;
      if (state.run_id !== run.id) throw new Error("iterative_run_mismatch");
      if (state.pending) throw new Error("iterative_pending_recovery_required");
      if (state.stopped) throw new Error("iterative_search_stopped");
      const source = pool.find((item) => item.kind === "source");
      if (!source || !run.lineage_nodes.some((node) => node.kind === "seed" && node.artifact_id === source.artifactId)) {
        throw new Error("iterative_source_unavailable");
      }
      validateHistory(state, run, pool, source.artifactId);
      let trajectory = state.trajectories.find((item) => item.name === action.trajectory);
      if (action.action === "STOP") {
        if (!trajectory) throw new Error("iterative_trajectory_not_found");
        if (trajectory.stopped && action.scope !== "search") throw new Error("iterative_trajectory_stopped");
        trajectory.stopped = true;
        trajectory.history.push({ action: "STOP", base_artifact_id: trajectory.path.at(-1)!, rationale: action.rationale,
          reference_artifact_ids: [], outcome: "stopped" });
        if (action.scope === "search") {
          state.stopped = true;
          for (const item of state.trajectories) item.stopped = true;
        }
        await this.save("stopped");
        if (action.scope === "search") tools.signalStop();
        return { action: action.action, state: this.snapshot()! };
      }

      // Attach one already charged, reviewed external draft (e.g. SVG), never an arbitrary image.
      if (action.action === "ADOPT") {
        if (run.status !== "running") throw new Error("iterative_run_not_running");
        if (!trajectory) throw new Error("iterative_trajectory_not_found");
        if (trajectory.stopped) throw new Error("iterative_trajectory_stopped");
        const draft = run.drafts.find((item) => item.id === action.draft_id);
        if (!draft) throw new Error("iterative_adopt_draft_not_found");
        selectableParent(run, pool, draft.artifact_id);
        if (draft.status === "ambiguous" || draft.status === "rejected_preverify") throw new Error("iterative_base_not_selectable");
        if (!draft.viewed_at || !run.evaluations.some((item) => item.artifact_id === draft.artifact_id)) {
          throw new Error("draft_requires_view_and_evaluation_before_adoption");
        }
        const parentIndex = trajectory.path.lastIndexOf(draft.parent_artifact_id);
        if (parentIndex < 0) throw new Error("iterative_adopt_requires_path_parent");
        if (state.trajectories.some((item) => item.path.includes(draft.artifact_id)
          || item.history.some((fact) => fact.artifact_id === draft.artifact_id))) throw new Error("iterative_adopt_already_tracked");
        const visible = new Set(pool.map((item) => item.artifactId));
        if (draft.generation_input.reference_artifact_ids.some((id) => !visible.has(id))) throw new Error("iterative_reference_not_main_visible");
        trajectory.path = [...trajectory.path.slice(0, parentIndex + 1), draft.artifact_id];
        trajectory.history.push({ action: "ADOPT", base_artifact_id: draft.parent_artifact_id, artifact_id: draft.artifact_id,
          draft_id: draft.id, rationale: action.rationale, reference_artifact_ids: [...draft.generation_input.reference_artifact_ids], outcome: "adopted" });
        await this.save("adopted");
        return { action: action.action, artifact_id: draft.artifact_id, draft_id: draft.id, state: this.snapshot()! };
      }

      assertGenerationBudget(run, state, this.options.now?.() ?? Date.now());
      const remaining = run.config.max_generations - run.generation_count - state.extra_generation_charges;
      if (action.action === "FRESH_START") {
        if (trajectory) throw new Error("iterative_trajectory_already_exists");
        if (state.trajectories.length >= state.planned_starts) throw new Error("iterative_start_limit");
        if (state.trajectories.some((item) => normalize(item.strategy) === normalize(action.strategy))) {
          throw new Error("iterative_distinct_strategy_required");
        }
      } else {
        if (!trajectory) throw new Error("iterative_trajectory_not_found");
        if (trajectory.stopped) throw new Error("iterative_trajectory_stopped");
        if (remaining <= state.planned_starts - state.trajectories.length) throw new Error("iterative_budget_reserved_for_new_starts");
      }
      const base = action.action === "FRESH_START" ? source.artifactId
        : action.action === "BACKTRACK" ? action.base_artifact_id : trajectory!.path.at(-1)!;
      if (action.action === "BACKTRACK" && !trajectory!.path.slice(0, -1).includes(base)) {
        throw new Error("iterative_backtrack_requires_path_ancestor");
      }
      const parent = selectableParent(run, pool, base);
      const visible = new Set(pool.map((item) => item.artifactId));
      if (action.reference_artifact_ids.some((id) => !visible.has(id))) throw new Error("iterative_reference_not_main_visible");
      const references = [...new Set(action.reference_artifact_ids)];
      const latest = run.drafts.findLast((draft) => draft.round === run.active_variation_attempt);
      if (latest && (!latest.viewed_at || !run.evaluations.some((item) => item.artifact_id === latest.artifact_id))) {
        throw new Error("draft_requires_view_and_evaluation_before_next_generation");
      }
      if (!trajectory) {
        trajectory = { name: action.trajectory, strategy: action.action === "FRESH_START" ? action.strategy : "",
          path: [source.artifactId], stopped: false, history: [] };
        state.trajectories.push(trajectory);
      }
      // Reserve before mutation; reconcile with core accounting after a generation failure.
      state.extra_generation_charges += 1;
      state.pending = { trajectory: trajectory.name, action };
      await this.save("reserved");
      let generated: string;
      const beforeCount = run.generation_count;
      let generationInvoked = false;
      try {
        await tools.selectParent(parent, action.rationale, action.override_rationale);
        await tools.selectReferences(references, action.reference_usage);
        await tools.setPrompt(action.prompt);
        assertGenerationBudget(tools.getRunSnapshot(), { ...state, extra_generation_charges: state.extra_generation_charges - 1 }, this.options.now?.() ?? Date.now());
        generationInvoked = true;
        generated = await tools.generateImage();
      } catch (error) {
        // generateDraft may persist an ambiguous charge then throw before refreshing the toolbox.
        // A failed refresh leaves pending intact: reload/reconcile rather than refund blindly.
        if (generationInvoked) await tools.listImagePool();
        if (!generationInvoked || tools.getRunSnapshot().generation_count > beforeCount) state.extra_generation_charges -= 1;
        trajectory.history.push({ action: action.action, base_artifact_id: base, prompt: action.prompt,
          rationale: action.rationale, reference_artifact_ids: references, outcome: "failed" });
        state.pending = undefined;
        await this.save("failed");
        throw error;
      }
      const after = tools.getRunSnapshot();
      const draft = after.drafts.findLast((item) => item.artifact_id === generated && item.parent_artifact_id === base);
      if (!draft) throw new Error("iterative_generated_draft_missing_recovery_required");
      if (after.generation_count > beforeCount) state.extra_generation_charges -= 1;
      trajectory.path = [...trajectory.path.slice(0, trajectory.path.lastIndexOf(base) + 1), generated];
      trajectory.history.push({ action: action.action, base_artifact_id: base, artifact_id: generated,
        draft_id: draft.id, prompt: action.prompt, rationale: action.rationale, reference_artifact_ids: references, outcome: "generated" });
      state.pending = undefined;
      await this.save("generated");
      return { action: action.action, artifact_id: generated, draft_id: draft.id, state: this.snapshot()! };
    } finally {
      this.busy = false;
    }
  }

  private async save(phase: IterativeCheckpoint["data"]["phase"]) {
    this.state!.revision += 1;
    try {
      await this.options.checkpoint({ type: "experiment.iterative.checkpoint", data: { phase, state: this.snapshot()! } });
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
  }
}

function selectableParent(run: RunSnapshot, pool: ImagePoolItem[], id: string): string {
  if (!pool.some((item) => item.artifactId === id)) throw new Error("iterative_base_not_main_visible");
  const node = run.lineage_nodes.find((item) => item.artifact_id === id && (item.kind === "seed" || item.kind === "commit"));
  if (node) return node.id;
  const draft = run.drafts.find((item) => item.artifact_id === id && item.status !== "rejected_preverify" && item.status !== "ambiguous");
  if (!draft) throw new Error("iterative_base_not_selectable");
  return draft.id;
}

function validateHistory(state: IterativeState, run: RunSnapshot, pool: ImagePoolItem[], source: string) {
  const visible = new Set(pool.map((item) => item.artifactId));
  if (new Set(state.trajectories.map((item) => item.name)).size !== state.trajectories.length) throw new Error("iterative_duplicate_trajectory");
  for (const trajectory of state.trajectories) {
    if (trajectory.path[0] !== source) throw new Error("iterative_invalid_history_root");
    for (const id of trajectory.path) if (!visible.has(id)) throw new Error("iterative_history_not_main_visible");
    for (const fact of trajectory.history) {
      if (![fact.base_artifact_id, ...fact.reference_artifact_ids, ...(fact.artifact_id ? [fact.artifact_id] : [])].every((id) => visible.has(id))) {
        throw new Error("iterative_history_not_main_visible");
      }
      if ((fact.outcome === "generated" || fact.outcome === "adopted") && !run.drafts.some((draft) => draft.id === fact.draft_id
        && draft.artifact_id === fact.artifact_id && draft.parent_artifact_id === fact.base_artifact_id)) throw new Error("iterative_invalid_history_fact");
    }
    for (let index = 1; index < trajectory.path.length; index++) {
      if (!trajectory.history.some((fact) => (fact.outcome === "generated" || fact.outcome === "adopted") && fact.artifact_id === trajectory.path[index]
        && fact.base_artifact_id === trajectory.path[index - 1])) throw new Error("iterative_invalid_history_path");
    }
  }
}

function assertGenerationBudget(run: RunSnapshot, state: IterativeState, now: number) {
  if (run.status !== "running") throw new Error("iterative_run_not_running");
  if (run.pending_decision || run.pending_finalization) throw new Error("iterative_decision_required");
  if (run.generation_count + state.extra_generation_charges >= run.config.max_generations) throw new Error("generation_budget_exhausted");
  if (run.drafts.filter((draft) => draft.round === run.active_variation_attempt).length >= run.config.max_generations_per_round) {
    throw new Error("variation_attempt_generation_budget_exhausted");
  }
  if (run.started_at && now >= Date.parse(run.started_at) + run.config.max_wall_time_ms) throw new Error("iterative_wall_time_exhausted");
  if (run.config.max_agent_tokens !== undefined && run.agent_total_tokens >= run.config.max_agent_tokens) throw new Error("iterative_token_budget_exhausted");
  if (run.step_deadline && (run.step_deadline.state !== "open" || now >= Date.parse(run.step_deadline.soft_deadline_at)
    || now >= Date.parse(run.step_deadline.hard_deadline_at))) throw new Error("iterative_decision_only");
}

function normalize(value: string) { return value.trim().replace(/\s+/g, " ").toLowerCase(); }

/** Only exposes allowlisted trajectory facts, never evaluations, paths, task internals or sealed data. */
export function iterativeContext(enabled: boolean, run: RunSnapshot, state?: IterativeState, pool?: ImagePoolItem[]): string {
  if (!enabled) return "";
  if (state && state.run_id !== run.id) throw new Error("iterative_run_mismatch");
  if (state) {
    const source = pool?.find((item) => item.kind === "source");
    if (!source || !pool) throw new Error("iterative_context_requires_main_pool");
    validateHistory(state, run, pool, source.artifactId);
  }
  return [
    "Optional iterative search: Main chooses FRESH_START (new named strategy from Source), CONTINUE (trajectory head), BACKTRACK (active path ancestor), or STOP (trajectory or search).",
    "Use avo_iterative_action. Each generating action makes at most one ordinary image call. View and evaluate each result with existing tools before continuing; submit/decline through existing gates. No automatic score-max selection.",
    "ADOPT with trajectory, draft_id and rationale attaches one reviewed Main-visible external draft (including SVG) whose parent is on the active path, without generating or charging again. CONTINUE then edits that draft. It does not submit or accept it.",
    "Independent starts are serial and share the run budget. Name genuinely different approaches. Unstarted planned trajectories reserve one call each. STOP search uses the existing stop/finalization flow; it does not accept a candidate.",
    JSON.stringify({ remaining_generations: Math.max(0, run.config.max_generations - run.generation_count - (state?.extra_generation_charges ?? 0)),
      planned_starts: state?.planned_starts, stopped: state?.stopped ?? false,
      trajectories: state?.trajectories.map((item) => ({ name: item.name, strategy: item.strategy, path: item.path, stopped: item.stopped })) ?? [] }),
  ].join("\n");
}
