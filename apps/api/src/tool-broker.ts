import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DraftEvaluation, RunSnapshot, StepDeadline, WorkingMemory } from "@avo/contracts";
import { generationInputSchema, trialClaimSchema } from "@avo/contracts";
import type { AgentRoundContext, AgentToolbox } from "@avo/core";
import { assertReferenceUsage, trialEvidence } from "@avo/core";
import sharp from "sharp";
import type { SvgEditor } from "./svg-editor.ts";
import { experimentalToolNames } from "./experimental-tools.ts";
import { PHOTO_ENGINE_REVISION, photoRecipeKey, photoRecipeSchema, photoRegionSchema, renderPhoto } from "./photo-editor.ts";
import { IterativeSearch, iterativeActionSchema, iterativeStateSchema, iterativeContext } from "./experiment-iterative.ts";
import { updateCopilotPlan, copilotContext } from "./experiment-copilot.ts";
import { assertExperimentalBudget, copilotEnvironment, plannedEdit, readCopilotState, recordPlannedCandidate, recordPlannedFailure, type PlannedExecution } from "./experiment-runtime.ts";

type Session = {
  tools: AgentToolbox;
  context: AgentRoundContext;
  expiresAt: number;
  invocations: number;
  queue: Promise<void>;
  closed: boolean;
  viewedArtifacts: Set<string>;
  returnedEvaluationIds: Set<string>;
  deadline: StepDeadline;
  decisionRequired?: { reason: string; draftId?: string; evaluationId?: string; decisionId?: string };
  svgPlans: Map<string, PlannedExecution & { documentRevision: number }>;
  photoPreviews: Set<string>;
};

const MAX_VARIATION_STEP_TOOL_CALLS = 64;

export class AgentToolBroker {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: { previewMaxEdge?: number; svg?: SvgEditor } = {}) {}

  register(token: string, tools: AgentToolbox, context: AgentRoundContext, deadline?: StepDeadline, ttlMs?: number) {
    const startedAt = Date.now();
    const resolvedDeadline = deadline ?? {
      started_at: new Date(startedAt).toISOString(),
      soft_deadline_at: new Date(startedAt + 15 * 60_000).toISOString(),
      hard_deadline_at: new Date(startedAt + 20 * 60_000).toISOString(),
      state: "open" as const,
    };
    this.sessions.set(token, {
      tools,
      context,
      expiresAt: Date.parse(resolvedDeadline.hard_deadline_at) + (ttlMs ?? 5 * 60_000),
      invocations: 0,
      queue: Promise.resolve(),
      closed: false,
      viewedArtifacts: new Set(),
      returnedEvaluationIds: new Set(),
      deadline: resolvedDeadline,
      svgPlans: new Map(),
      photoPreviews: new Set(),
      ...(tools.getRunSnapshot().pending_decision ? { decisionRequired: { reason: "pending_decision" } } : {}),
    });
    return () => {
      this.sessions.delete(token);
      void this.options.svg?.closeRun(context.run.id).catch(() => {});
    };
  }

  beginClosing(token: string) {
    const session = this.sessions.get(token);
    if (session) session.closed = true;
  }

  async waitForIdle(token: string) {
    await this.sessions.get(token)?.queue;
  }

  async invoke(token: string, name: string, args: Record<string, unknown>) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      throw new Error("invalid_or_expired_tool_session");
    }
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = session.queue;
    session.queue = previous.then(() => current);
    await previous;
    if (session.closed) {
      release();
      throw new Error("agent_round_closed");
    }
    if (/^avo_(svg_|photo_|view_detail|iterative_action|update_copilot_plan)/.test(name)
      && !experimentalToolNames(session.tools.getRunSnapshot().config.experimental_features).includes(name)) {
      release();
      throw new Error("experimental_tool_disabled");
    }
    const allowedDuringDecision = new Set([
      "avo_get_evaluation",
      "avo_get_trial_evidence",
      "avo_view_image",
      "avo_view_detail",
      "avo_evaluate_draft",
      "avo_submit_candidate",
      "avo_abandon_step",
      "avo_abandon_attempt",
      "avo_decline_pending_decision",
      ...(session.tools.getRunSnapshot().config?.experimental_features?.svg_editing ? ["avo_svg_finalize"] : []),
    ]);
    if (session.decisionRequired && !allowedDuringDecision.has(name)) {
      const result = await attachDeadline(session, {
          decision_required: true,
          reason: session.decisionRequired.reason,
          allowed_actions: [...allowedDuringDecision],
          draft_id: session.decisionRequired.draftId,
          evaluation_id: session.decisionRequired.evaluationId,
          decision_id: session.decisionRequired.decisionId,
          pending_decision: toolsPendingDecision(session),
          instruction: "Resolve the measured candidates now. Submit, abandon, or explicitly decline a carried decision before continuing search.",
        });
      release();
      return result;
    }
    session.invocations += 1;
    if (session.invocations > MAX_VARIATION_STEP_TOOL_CALLS) {
      session.tools.signalBudgetExceeded("agent_tool_call_limit_exhausted");
      session.closed = true;
      release();
      throw new Error("agent_tool_call_limit_exhausted");
    }
    const tools = session.tools;
    try {
      await tools.recordAgentRuntime({ toolCalls: 1 });
      const result = await (async () => {
      switch (name) {
      case "avo_set_edit_plan": {
        const input = generationInputSchema.parse(args);
        if (input.reference_usage === undefined) throw new Error("edit_plan_requires_reference_usage");
        assertReferenceUsage(input);
        if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("edit_plan_prompt_required");
        await tools.selectGenerationInputs(input);
        await tools.setPrompt(args.prompt);
        return { base_artifact_id: input.base_artifact_id, reference_artifact_ids: input.reference_artifact_ids,
          reference_usage: input.reference_usage, prompt: tools.getPrompt(),
          clean_source_input: input.base_artifact_id === session.context.task.source_artifact_id && !input.reference_artifact_ids.length,
          warning: "Reference purpose is not a mask. Generated references can reintroduce defects even with Source as base." };
      }
      case "avo_get_trial_evidence": {
        const run = tools.getRunSnapshot();
        const ids = args.draft_ids === undefined ? run.drafts.slice(-1).map((draft) => draft.id) : strings(args.draft_ids);
        if (ids.length > 4 || ids.some((id) => !run.drafts.some((draft) => draft.id === id))) throw new Error("trial_evidence_unknown_draft");
        return { trials: trialEvidence(run, run.drafts.filter((draft) => ids.includes(draft.id))) };
      }
      case "avo_view_detail": {
        const item = (await tools.listImagePool()).find((image) => image.artifactId === String(args.artifact_id ?? ""));
        if (!item) throw new Error("image_not_in_public_pool");
        const region = photoRegionSchema.parse(args.region);
        const { data, info } = await sharp(item.path).rotate().raw().toBuffer({ resolveWithObject: true });
        const left = Math.min(info.width - 1, Math.floor(region.x * info.width));
        const top = Math.min(info.height - 1, Math.floor(region.y * info.height));
        const preview = await sharp(data, { raw: info }).extract({ left, top,
          width: Math.min(info.width - left, Math.max(1, Math.round(region.width * info.width))),
          height: Math.min(info.height - top, Math.max(1, Math.round(region.height * info.height))),
        }).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        return { artifact_id: item.artifactId, region, bytes_base64: preview.toString("base64"), mime_type: "image/png" };
      }
      case "avo_photo_preview":
      case "avo_photo_finalize": {
        assertEditorTime(session);
        const base = String(args.base_artifact_id ?? "");
        const run = tools.getRunSnapshot();
        if (run.parent_selection?.artifact_id !== base) throw new Error("photo_parent_selection_mismatch");
        const item = (await tools.listImagePool()).find((image) => image.artifactId === base);
        if (!item) throw new Error("image_not_in_public_pool");
        const recipe = photoRecipeSchema.parse(args.recipe);
        const key = photoRecipeKey(base, recipe);
        if (name === "avo_photo_finalize") {
          if (!session.photoPreviews.has(key)) throw new Error("photo_recipe_must_be_previewed");
          const existing = run.drafts.find((draft) => draft.photo_edit?.recipe_sha256 === key);
          if (existing) return { artifact_id: existing.artifact_id, draft_id: existing.id, deduplicated: true };
          assertExperimentalBudget(run);
          if (typeof args.description !== "string" || !args.description.trim()) throw new Error("photo_description_required");
        }
        const planned = name === "avo_photo_finalize" ? plannedEdit(session.context, tools, {
          route: "photo_adjustment", base, references: [], parameters: recipe,
        }) : undefined;
        const started = Date.now();
        let rendered: Awaited<ReturnType<typeof renderPhoto>>;
        try { rendered = await renderPhoto(await readFile(item.path), recipe); }
        catch (error) { await recordPlannedFailure(session.context, tools, planned, `photo-render-failed-${randomUUID()}`, error); throw error; }
        if (name === "avo_photo_preview") {
          const preview = await sharp(rendered.bytes).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
          session.photoPreviews.add(key);
          return { base_artifact_id: base, recipe, recipe_sha256: key, diagnostics: rendered.diagnostics,
            bytes_base64: preview.toString("base64"), mime_type: "image/png", dimensions: rendered.dimensions };
        }
        let artifactId: string;
        try {
          artifactId = await tools.recordEditedDraft({
            bytes: rendered.bytes, description: String(args.description), parentArtifactId: base,
            photoEdit: { base_artifact_id: base, engine_revision: PHOTO_ENGINE_REVISION, recipe_sha256: key, recipe },
            latencyMs: Date.now() - started,
          });
        } catch (error) { await recordPlannedFailure(session.context, tools, planned, `photo-failed-${randomUUID()}`, error); throw error; }
        await recordPlannedCandidate(session.context, tools, planned, artifactId);
        return { artifact_id: artifactId, draft_id: tools.getRunSnapshot().drafts.findLast((draft) => draft.artifact_id === artifactId)?.id,
          creation_method: "photo_adjustment", recipe_sha256: key, diagnostics: rendered.diagnostics,
          instruction: "View the complete candidate with avo_view_image, then evaluate it. This is not a Commit." };
      }
      case "avo_svg_tools": return this.requireSvg().capabilities(tools, typeof args.operation === "string" ? args.operation : undefined);
      case "avo_svg_open": {
        assertEditorTime(session);
        return this.requireSvg().open(tools, String(args.parent_artifact_id ?? ""));
      }
      case "avo_svg_edit": {
        assertEditorTime(session);
        const documentId = String(args.document_id ?? "");
        const parameters = objectArgument(args.parameters);
        const command = String(args.operation ?? "");
        const document = await this.requireSvg().documentState(tools, documentId);
        const references = command === "add_image" && parameters.artifact_id !== document.parent
          ? [...document.references, String(parameters.artifact_id ?? "")] : document.references;
        const planned = plannedEdit(session.context, tools, {
          route: "svg_edit", base: document.parent, references, command, parameters,
        });
        let result;
        try { result = await this.requireSvg().edit(tools, documentId, command, parameters); }
        catch (error) { await recordPlannedFailure(session.context, tools, planned, `svg-failed-${randomUUID()}`, error); throw error; }
        if (planned) session.svgPlans.set(documentId, { ...planned, documentRevision: result.revision });
        return result;
      }
      case "avo_svg_preview": return this.requireSvg().preview(tools, String(args.document_id ?? ""));
      case "avo_svg_finalize": {
        if (Date.now() >= Date.parse(session.deadline.hard_deadline_at)) throw new Error("agent_round_closed");
        assertExperimentalBudget(tools.getRunSnapshot());
        const documentId = String(args.document_id ?? "");
        const binding = session.svgPlans.get(documentId);
        if (tools.getRunSnapshot().config.experimental_features?.copilot_routing) {
          if (!binding) throw new Error("copilot_svg_edit_plan_required");
          const document = await this.requireSvg().documentState(tools, documentId);
          if (document.revision !== binding.documentRevision || readCopilotState(tools.getRunSnapshot())?.revisions.at(-1)?.revision !== binding.revision) {
            throw new Error("copilot_svg_plan_stale");
          }
        }
        let result;
        try { result = await this.requireSvg().finalize(tools, documentId, String(args.description ?? "")); }
        catch (error) { await recordPlannedFailure(session.context, tools, binding, `svg-finalize-failed-${randomUUID()}`, error); throw error; }
        await recordPlannedCandidate(session.context, tools, binding, result.artifact_id);
        return result;
      }
      case "avo_update_copilot_plan": {
        const run = tools.getRunSnapshot();
        const next = updateCopilotPlan(readCopilotState(run), objectArgument(args.plan), copilotEnvironment(session.context, tools));
        await tools.recordExperimentState("copilot", next, { phase: "plan_updated", revision: next.revisions.length });
        return copilotContext(next, copilotEnvironment(session.context, tools));
      }
      case "avo_iterative_action": {
        const action = iterativeActionSchema.parse(objectArgument(args.action));
        const run = tools.getRunSnapshot();
        const state = run.experimental_state?.iterative === undefined ? undefined : iterativeStateSchema.parse(run.experimental_state.iterative);
        let planned: PlannedExecution | undefined;
        if (action.action !== "STOP" && action.action !== "ADOPT") {
          if (!generationTiming(run, session.deadline).allowed) throw new Error("step_deadline_insufficient_for_generation");
          const base = action.action === "FRESH_START" ? session.context.task.source_artifact_id
            : action.action === "BACKTRACK" ? action.base_artifact_id
            : state?.trajectories.find((item) => item.name === action.trajectory)?.path.at(-1) ?? "";
          planned = plannedEdit(session.context, tools, { route: "image_generator", base, prompt: action.prompt, references: action.reference_artifact_ids });
        }
        const search = new IterativeSearch({
          enabled: true, ...(state ? { state } : {}),
          checkpoint: ({ data }) => tools.recordExperimentState("iterative", data.state, { phase: data.phase }),
        });
        let result;
        try { result = await search.execute(tools, action); }
        catch (error) { await recordPlannedFailure(session.context, tools, planned, `iterative-failed-${randomUUID()}`, error); throw error; }
        if ("artifact_id" in result && result.artifact_id) await recordPlannedCandidate(session.context, tools, planned, result.artifact_id);
        return {
          action: result.action,
          ...("artifact_id" in result ? { artifact_id: result.artifact_id, draft_id: result.draft_id } : {}),
          state_summary: iterativeContext(true, tools.getRunSnapshot(), result.state, await tools.listImagePool()),
        };
      }
      case "avo_get_task": return { task: session.context.task, checklist: session.context.checklist };
      case "avo_get_state": return {
        run: agentRunProjection(tools.getRunSnapshot()),
        recent_attempts: session.context.recentAttempts.slice(-5).map((attempt) => ({
          id: attempt.id,
          round: attempt.round,
          draft_id: attempt.draft_id,
          generated_artifact_id: attempt.generated_artifact_id,
          status: attempt.status,
          score: attempt.verification?.overall_score,
          feedback: attempt.verification?.feedback,
        })),
        supervisor_redirect: session.context.supervisorRedirect ?? null,
        supervisor_decision: session.context.supervisorDecision ?? null,
      };
      case "avo_get_lineage": {
        const run = tools.getRunSnapshot();
        return { nodes: tools.getLineage(), incumbent_node_id: run.incumbent_node_id, active_version: run.active_evolution_version };
      }
      case "avo_get_memory": return tools.getMemory();
      case "avo_get_evaluation": {
        const evaluation = tools.getEvaluation(String(args.evaluation_id ?? ""));
        const decision = tools.getRunSnapshot().comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id);
        const cacheHit = session.returnedEvaluationIds.has(evaluation.id);
        session.returnedEvaluationIds.add(evaluation.id);
        return cacheHit ? agentEvaluationSummary(evaluation, decision, true) : agentEvaluationProjection(evaluation, decision, false);
      }
      case "avo_list_image_pool": return {
        items: (await tools.listImagePool()).map(({ path: _path, draft, ...item }) => ({
          ...item,
          ...(draft ? { draft_id: draft.id, status: draft.status, viewed: Boolean(draft.viewed_at),
            parent_artifact_id: draft.parent_artifact_id, creation_method: draft.creation_method ?? "image_provider",
            generation_input: draft.generation_input, photo_edit: draft.photo_edit } : {}),
        })),
      };
      case "avo_view_image": {
        const artifactId = String(args.artifact_id ?? "");
        if (session.viewedArtifacts.has(artifactId)) {
          const draft = tools.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId || item.raw_artifact_id === artifactId);
          return {
            artifact_id: artifactId,
            ...(draft ? { draft_id: draft.id } : {}),
            already_viewed: true,
            instruction: "Use the image evidence already present in this Step context; do not request it again.",
          };
        }
        const image = await tools.viewImage(artifactId);
        const bytes = await readFile(image.path);
        const preview = await sharp(bytes)
          .rotate()
          .resize({
            width: this.options.previewMaxEdge ?? 1_024,
            height: this.options.previewMaxEdge ?? 1_024,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer();
        const draft = tools.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId || item.raw_artifact_id === artifactId);
        session.viewedArtifacts.add(artifactId);
        return {
          artifact_id: artifactId,
          ...(draft ? { draft_id: draft.id } : {}),
          bytes_base64: preview.toString("base64"),
          mime_type: "image/webp",
          preview_max_edge: this.options.previewMaxEdge ?? 1_024,
        };
      }
      case "avo_get_prompt": return { prompt: tools.getPrompt() };
      case "avo_set_prompt": {
        const prompt = String(args.prompt ?? "");
        if (tools.getPrompt() === prompt) return { ok: true, deduplicated: true };
        await tools.setPrompt(prompt);
        return { ok: true };
      }
      case "avo_append_prompt": await tools.appendPrompt(String(args.fragment ?? "")); return { ok: true };
      case "avo_replace_prompt": await tools.replacePrompt(String(args.old_text ?? ""), String(args.new_text ?? "")); return { ok: true };
      case "avo_delete_prompt_fragment": await tools.deletePromptFragment(String(args.fragment ?? "")); return { ok: true };
      case "avo_select_parent": return await tools.selectParent(
        String(args.parent_node_id ?? ""),
        String(args.rationale ?? ""),
        typeof args.override_rationale === "string" ? args.override_rationale : undefined,
      );
      case "avo_select_references":
        await tools.selectReferences(strings(args.artifact_ids));
        return { ok: true };
      case "avo_select_generation_inputs":
        await tools.selectGenerationInputs(generationInputSchema.parse({
          base_artifact_id: String(args.base_artifact_id ?? ""),
          reference_artifact_ids: strings(args.reference_artifact_ids),
          ...(args.reference_usage ? { reference_usage: args.reference_usage } : {}),
        }));
        return { ok: true };
      case "avo_generate_image": {
        const run = tools.getRunSnapshot();
        if (run.config.experimental_features?.iterative_search) throw new Error("iterative_use_action_for_generation");
        assertExperimentalBudget(run);
        const timing = generationTiming(run, session.deadline);
        if (!timing.allowed) {
          session.decisionRequired = { reason: "step_deadline_insufficient_for_generation" };
          return {
            ok: false,
            error: "step_deadline_insufficient_for_generation",
            generation_estimate_ms: timing.generationEstimateMs,
            evaluation_estimate_ms: timing.evaluationEstimateMs,
            decision_reserve_ms: timing.decisionReserveMs,
            instruction: "Do not generate again. Evaluate any remaining viewed draft, then submit or abandon this Step.",
          };
        }
        const prompt = tools.getPrompt();
        const latest = run.drafts.findLast((draft) => draft.round === run.active_variation_attempt);
        const selectedInput = run.selected_generation_input;
        const sameReferences = latest && selectedInput
          ? latest.generation_input.reference_artifact_ids.length === selectedInput.reference_artifact_ids.length
            && latest.generation_input.reference_artifact_ids.every((id, index) => id === selectedInput.reference_artifact_ids[index])
          : false;
        if (latest && prompt === latest.prompt && selectedInput
          && latest.parent_artifact_id === selectedInput.base_artifact_id && sameReferences) {
          return { artifact_id: latest.artifact_id, draft_id: latest.id, deduplicated: true };
        }
        const planned = plannedEdit(session.context, tools, { route: "image_generator", base: run.selected_generation_input?.base_artifact_id ?? "", prompt, references: run.selected_generation_input?.reference_artifact_ids ?? [] });
        let artifactId: string;
        try { artifactId = await tools.generateImage(); }
        catch (error) { await recordPlannedFailure(session.context, tools, planned, `generation-failed-${randomUUID()}`, error); throw error; }
        await recordPlannedCandidate(session.context, tools, planned, artifactId);
        const draft = tools.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId);
        return { artifact_id: artifactId, ...(draft ? { draft_id: draft.id } : {}) };
      }
      case "avo_evaluate_draft": {
        const draftId = resolveDraftId(tools.getRunSnapshot(), String(args.draft_id ?? ""));
        const evaluation = await tools.evaluateDraft(draftId);
        const run = tools.getRunSnapshot();
        const decision = evaluation.comparative_decision_id
          ? run.comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id)
          : undefined;
        if (!decision) throw new Error("comparative_decision_missing");
        const remainingGenerations = Math.max(0, run.config.max_generations - run.generation_count);
        if (remainingGenerations === 0) {
          session.decisionRequired = {
            reason: "generation_budget_exhausted",
            draftId: evaluation.draft_id,
            evaluationId: evaluation.id,
            decisionId: decision.id,
          };
        }
        const cacheHit = session.returnedEvaluationIds.has(evaluation.id);
        session.returnedEvaluationIds.add(evaluation.id);
        return {
          ...(cacheHit ? agentEvaluationSummary(evaluation, decision, true) : agentEvaluationProjection(evaluation, decision, false)),
          remaining_generations: remainingGenerations,
          supervisor_decision: run.pending_supervisor_decision ?? null,
          supervisor_failure: run.supervisor_failures.findLast((failure) => failure.variation_step === run.active_variation_attempt) ?? null,
          next_action: decision.recommendation === "commit"
            ? `The Verifier recommends Commit. Submit draft_id=${evaluation.draft_id} with decision_id=${decision.id}, or continue only with a concrete reason.`
            : remainingGenerations === 0
              ? "Generation budget is exhausted and this candidate is not better. Abandon this Attempt."
              : "The candidate is not strictly better than the incumbent. Revise, change parent, or abandon this Attempt.",
        };
      }
      case "avo_restore_attempt": await tools.restoreAttempt(String(args.attempt_id ?? "")); return { ok: true };
      case "avo_decline_pending_decision":
        await tools.declinePendingDecision(String(args.rationale ?? ""));
        delete session.decisionRequired;
        return { ok: true };
      case "avo_update_working_memory":
        await tools.updateWorkingMemory({
          useful_findings: strings(args.useful_findings),
          failed_directions: strings(args.failed_directions),
          current_hypotheses: strings(args.current_hypotheses),
          preservation_constraints: strings(args.preservation_constraints),
        });
        return { ok: true };
      case "avo_upsert_hypothesis": return await tools.upsertHypothesis({
        id: String(args.id ?? ""),
        statement: String(args.statement ?? ""),
        status: String(args.status ?? "proposed") as "proposed" | "active" | "supported" | "refuted" | "retired",
        evidence_refs: strings(args.evidence_refs),
        ...(args.trial_claim ? { trial_claim: trialClaimSchema.parse(args.trial_claim) } : {}),
        ...(args.alternative_explanations ? { alternative_explanations: strings(args.alternative_explanations) } : {}),
      });
      case "avo_abandon_step":
      case "avo_abandon_attempt": {
        await tools.abandonStep(String(args.reason ?? ""), {
          observation: String(args.observation ?? ""),
          hypothesis: String(args.hypothesis ?? ""),
          intervention: String(args.intervention ?? ""),
        }, memoryFromArgs(args.memory_update));
        session.closed = true;
        return { ok: true };
      }
      case "avo_submit_candidate": {
        const draftId = resolveDraftId(tools.getRunSnapshot(), String(args.draft_id ?? ""));
        const submitted = await tools.submitCandidate(
          draftId,
          String(args.decision_id ?? args.evaluation_id ?? ""),
          {
          observation: String(args.observation ?? ""),
          hypothesis: String(args.hypothesis ?? ""),
          intervention: String(args.intervention ?? ""),
          },
          memoryFromArgs(args.memory_update),
        );
        session.closed = true;
        return {
          ok: true,
          draft_id: submitted.draftId,
          artifact_id: submitted.artifactId,
          evaluation_id: submitted.evaluationId,
          decision_id: submitted.decisionId,
        };
      }
      default: throw new Error("unknown_agent_tool");
      }
      })();
      return await attachDeadline(session, result);
    } finally {
      release();
    }
  }

  private requireSvg() {
    if (!this.options.svg) throw new Error("svg_engine_not_configured");
    return this.options.svg;
  }
}

const objectArgument = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected_object_argument");
  return parsed as Record<string, unknown>;
};

const assertEditorTime = (session: Session) => {
  if (Date.now() >= Date.parse(session.deadline.soft_deadline_at)
    || Date.now() + 120_000 >= Date.parse(session.deadline.hard_deadline_at)) throw new Error("step_deadline_insufficient_for_generation");
};

const strings = (value: unknown) => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const memoryFromArgs = (value: unknown): WorkingMemory | undefined => {
  if (typeof value === "string") {
    try { return memoryFromArgs(JSON.parse(value) as unknown); }
    catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const memory = value as Record<string, unknown>;
  return {
    useful_findings: strings(memory.useful_findings),
    failed_directions: strings(memory.failed_directions),
    current_hypotheses: strings(memory.current_hypotheses),
    preservation_constraints: strings(memory.preservation_constraints),
  };
};

const resolveDraftId = (run: RunSnapshot, draftOrArtifactId: string) =>
  run.drafts.findLast((draft) => draft.id === draftOrArtifactId
    || draft.artifact_id === draftOrArtifactId
    || draft.raw_artifact_id === draftOrArtifactId)?.id ?? draftOrArtifactId;

const agentRunProjection = (run: RunSnapshot) => ({
  id: run.id,
  status: run.status,
  mode: run.config.mode,
  active_variation_attempt: run.active_variation_attempt,
  active_evolution_version: run.active_evolution_version,
  generation_budget: { used: run.generation_count, limit: run.config.max_generations },
  evaluation_count: run.verifier_count,
  tool_call_count: run.tool_call_count,
  agent_total_tokens: run.agent_total_tokens,
  generation_prompt: run.generation_prompt,
  parent_selection: run.parent_selection,
  selected_reference_artifact_ids: run.selected_reference_artifact_ids,
  drafts: run.drafts.map((draft) => ({
    id: draft.id,
    round: draft.round,
    origin_step: draft.origin_step ?? draft.round,
    status: draft.status,
    artifact_id: draft.artifact_id,
    parent_artifact_id: draft.parent_artifact_id,
    viewed: Boolean(draft.viewed_at),
    evaluated: run.evaluations.some((evaluation) => evaluation.draft_id === draft.id),
  })),
  incumbent_node_id: run.incumbent_node_id,
  submitted_draft_id: run.submitted_draft_id,
  hypotheses: run.hypotheses,
  pending_supervisor_decision: run.pending_supervisor_decision,
  pending_decision: run.pending_decision,
  step_deadline: run.step_deadline,
  latest_validator_trends: run.validator_trends.slice(-8),
});

const agentEvaluationProjection = (
  evaluation: DraftEvaluation,
  decision: RunSnapshot["comparative_decisions"][number] | undefined,
  cacheHit: boolean,
) => ({
  id: evaluation.id,
  draft_id: evaluation.draft_id,
  artifact_id: evaluation.artifact_id,
  evaluator_revision: evaluation.evaluator_revision,
  decision_id: evaluation.comparative_decision_id,
  evaluation_frame_revision_id: evaluation.evaluation_frame_revision_id,
  verifier_feedback: evaluation.agent_feedback,
  comparison: decision ? {
    incumbent_node_id: decision.incumbent_node_id,
    preference: decision.preference,
    target_progress: decision.target_progress,
    confidence: decision.confidence,
    recommendation: decision.recommendation,
    delivery_status: decision.candidate_quality?.delivery_status ?? "not_assessed",
  } : undefined,
  correctness_gate: evaluation.correctness_gate,
  cache_hit: cacheHit,
  created_at: evaluation.created_at,
});

const agentEvaluationSummary = (
  evaluation: DraftEvaluation,
  decision: RunSnapshot["comparative_decisions"][number] | undefined,
  cacheHit: boolean,
) => ({
  id: evaluation.id,
  draft_id: evaluation.draft_id,
  artifact_id: evaluation.artifact_id,
  evaluator_revision: evaluation.evaluator_revision,
  decision_id: evaluation.comparative_decision_id,
  verifier_feedback: evaluation.agent_feedback.slice(0, 5),
  comparison: decision ? {
    preference: decision.preference,
    target_progress: decision.target_progress,
    confidence: decision.confidence,
    recommendation: decision.recommendation,
    delivery_status: decision.candidate_quality?.delivery_status ?? "not_assessed",
  } : undefined,
  correctness_gate: evaluation.correctness_gate,
  cache_hit: cacheHit,
});

const toolsPendingDecision = (session: Session) => session.tools.getRunSnapshot().pending_decision ?? null;

const deadlineSnapshot = (session: Session) => {
  const current = Date.now();
  const soft = Date.parse(session.deadline.soft_deadline_at);
  const hard = Date.parse(session.deadline.hard_deadline_at);
  const state = current >= hard
    ? "hard_cutoff" as const
    : current >= soft || Boolean(session.decisionRequired)
      ? "decision_only" as const
      : "open" as const;
  session.deadline.state = state;
  return { state, remainingMs: Math.max(0, hard - current) };
};

const attachDeadline = async (session: Session, result: unknown) => {
  const deadline = deadlineSnapshot(session);
  const run = session.tools.getRunSnapshot();
  const sessionStep = session.context.run?.active_variation_attempt ?? run.active_variation_attempt;
  if (run.step_deadline
    && run.active_variation_attempt === sessionStep
    && run.step_deadline.state !== session.deadline.state) {
    await session.tools.setStepDeadline({ ...session.deadline });
  }
  return {
    ...(result && typeof result === "object" && !Array.isArray(result) ? result : { result }),
    remaining_step_ms: deadline.remainingMs,
    deadline_state: deadline.state,
  };
};

const percentile95 = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
};

const generationTiming = (run: RunSnapshot, deadline: StepDeadline) => {
  const generationEstimateMs = Math.max(120_000, percentile95(run.drafts.slice(-20).map((draft) => draft.latency_ms)));
  const evaluationEstimateMs = Math.max(60_000, percentile95(run.evaluations.slice(-20).map((evaluation) =>
    run.comparative_decisions.find((decision) => decision.id === evaluation.comparative_decision_id)?.latency_ms
      ?? evaluation.public_verification.latency_ms + (evaluation.validator_elapsed_ms ?? 0))));
  const decisionReserveMs = 60_000;
  const current = Date.now();
  const hardRemaining = Date.parse(deadline.hard_deadline_at) - current;
  return {
    allowed: current < Date.parse(deadline.soft_deadline_at)
      && hardRemaining >= generationEstimateMs + evaluationEstimateMs + decisionReserveMs,
    generationEstimateMs,
    evaluationEstimateMs,
    decisionReserveMs,
  };
};
