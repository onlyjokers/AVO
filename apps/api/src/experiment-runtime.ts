import type { AgentRoundContext, AgentToolbox } from "@avo/core";
import type { RunSnapshot } from "@avo/contracts";
import { copilotContext, copilotStateSchema, type CopilotEnvironment, type CopilotOperation, type CopilotState, assertCopilotEdit, recordCopilotOutcome } from "./experiment-copilot.ts";
import { iterativeContext, iterativeStateSchema } from "./experiment-iterative.ts";
import { SVG_OPERATIONS } from "./svg-editor.ts";
import { photoRecipeSchema } from "./photo-editor.ts";

export function copilotEnvironment(context: AgentRoundContext, tools: AgentToolbox, svgCommands: readonly string[] = SVG_OPERATIONS): CopilotEnvironment {
  const run = tools.getRunSnapshot();
  return {
    run_id: run.id, ...(run.config.experimental_features ? { experimental_features: run.config.experimental_features } : {}),
    public_brief: {
      task_id: context.task.id, brief: context.task.user_brief,
      preservation: [JSON.stringify(context.task.preservation_contract)],
      checklist: context.checklist.requirements.map((item) => ({ id: item.id, text: item.statement })),
    },
    public_assets: [...new Set([
      context.task.source_artifact_id, ...context.task.references.map((item) => item.artifact_id),
      ...run.drafts.map((item) => item.artifact_id),
    ])].map((artifact_id) => ({ artifact_id, kind: "image" })),
    capabilities: [
      { id: "image_generator", route: "image_generator", operations: ["semantic"], scopes: ["full_image", "region"], masks: ["none"], accepts_image_base: true },
      ...(run.config.experimental_features?.photo_adjustments ? [{
        id: "photo_adjustment", route: "photo_adjustment" as const, operations: ["photo_adjustment"] as CopilotOperation["kind"][],
        scopes: ["full_image", "region"] as CopilotOperation["scope"]["kind"][], masks: ["none"] as CopilotOperation["mask"]["kind"][], accepts_image_base: true,
      }] : []),
      ...(run.config.experimental_features?.svg_editing ? [{
        id: "svg_edit", route: "svg_edit" as const, operations: ["opacity", "text", "color", "svg_structured"] as CopilotOperation["kind"][],
        scopes: ["full_image", "region"] as CopilotOperation["scope"]["kind"][],
        masks: ["none"] as CopilotOperation["mask"]["kind"][], accepts_image_base: true, svg_commands: [...svgCommands],
      }] : []),
    ],
  };
}

export const readCopilotState = (run: RunSnapshot): CopilotState | undefined =>
  run.experimental_state?.copilot === undefined ? undefined : copilotStateSchema.parse(run.experimental_state.copilot);

export type PlannedExecution = { operation: CopilotOperation; revision: number };

export function plannedEdit(context: AgentRoundContext, tools: AgentToolbox, input: {
  route: "image_generator" | "svg_edit" | "photo_adjustment";
  base: string;
  prompt?: string;
  command?: string;
  parameters?: Record<string, unknown>;
  references: string[];
}): PlannedExecution | undefined {
  if (!tools.getRunSnapshot().config.experimental_features?.copilot_routing) return undefined;
  const state = readCopilotState(tools.getRunSnapshot());
  const operation = state?.revisions.at(-1)?.operations.find((item) => {
    if (item.route !== input.route || item.base_artifact_id !== input.base
      || !equalJson(item.reference_artifact_ids, [...new Set(input.references)])) return false;
    const params = item.parameters;
    if (params.kind === "photo_adjustment") return equalJson(params.recipe, photoRecipeSchema.parse(input.parameters));
    if (params.kind === "semantic") return params.prompt === input.prompt;
    if (params.kind === "svg_structured") return params.command === input.command && equalJson(params.arguments, input.parameters);
    if (params.kind === "opacity") return input.command === "set_layer_state" && input.parameters?.opacity === params.value;
    if (params.kind === "text") return ["add_text", "edit_text"].includes(input.command ?? "") && input.parameters?.content === params.value;
    return input.command === "apply_color_overlay" && input.parameters?.color === params.value;
  });
  if (!operation) throw new Error("copilot_current_edit_needs_matching_plan");
  assertCopilotEdit(state, operation, copilotEnvironment(context, tools));
  return { operation, revision: state!.revisions.at(-1)!.revision };
}

export async function recordPlannedCandidate(context: AgentRoundContext, tools: AgentToolbox, planned: PlannedExecution | undefined, artifactId: string) {
  if (!planned) return;
  const run = tools.getRunSnapshot();
  const state = readCopilotState(run)!;
  const draft = run.drafts.findLast((item) => item.artifact_id === artifactId);
  if (!draft) throw new Error("copilot_candidate_missing");
  const outcome = {
    execution_id: draft.id, revision: planned.revision, operation_id: planned.operation.id,
    status: "succeeded", artifact_id: artifactId, draft_id: draft.id,
    observation: "Candidate materialized; this is not a Verifier acceptance. Inspect and evaluate it.",
  };
  const next = recordCopilotOutcome(state, outcome, copilotEnvironment(context, tools));
  await tools.recordExperimentState("copilot", next, { phase: "candidate_created", draft_id: draft.id });
}

export async function recordPlannedFailure(context: AgentRoundContext, tools: AgentToolbox, planned: PlannedExecution | undefined, executionId: string, error: unknown) {
  if (!planned) return;
  const state = readCopilotState(tools.getRunSnapshot())!;
  const next = recordCopilotOutcome(state, {
    execution_id: executionId, revision: planned.revision, operation_id: planned.operation.id, status: "failed",
    error: ((error as Error).message || "edit_failed").slice(0, 4_000), observation: "The execution failed before returning a candidate.",
  }, copilotEnvironment(context, tools));
  await tools.recordExperimentState("copilot", next, { phase: "execution_failed", operation_id: planned.operation.id });
}

export function assertExperimentalBudget(run: RunSnapshot) {
  if (!run.config.experimental_features?.iterative_search) return;
  const state = run.experimental_state?.iterative === undefined ? undefined : iterativeStateSchema.parse(run.experimental_state.iterative);
  if (state?.pending) throw new Error("iterative_pending_recovery_required");
  if (run.generation_count + (state?.extra_generation_charges ?? 0) >= run.config.max_generations) throw new Error("generation_budget_exhausted");
}

export function experimentPrompt(context: AgentRoundContext): string {
  const run = context.run;
  const parts: string[] = [];
  if (run.config.experimental_features?.iterative_search) {
    const state = run.experimental_state?.iterative === undefined ? undefined : iterativeStateSchema.parse(run.experimental_state.iterative);
    parts.push(iterativeContext(true, run, state, context.imagePool));
    parts.push("In this experimental arm use avo_iterative_action for image-model calls; the ordinary avo_generate_image tool is not registered. The action sets your authored prompt, references and parent itself. Two independent Source-rooted strategies share the budget. Deterministic SVG tools remain available: use ADOPT to attach a viewed/evaluated SVG child to a trajectory before CONTINUE. Stop early when justified; no fixed stage pipeline is imposed.");
  }
  if (run.config.experimental_features?.copilot_routing) {
    const environment = copilotEnvironment(context, { getRunSnapshot: () => run } as AgentToolbox);
    parts.push(`T2I-Copilot-inspired interpretation and tool routing: ${JSON.stringify(copilotContext(readCopilotState(run), environment))}`);
    if (run.config.experimental_features?.photo_adjustments) parts.push("For deterministic tonal edits use route=capability=kind='photo_adjustment', parameters={kind:'photo_adjustment',recipe:<the exact recipe>}, no reference_artifact_ids, mask={kind:'none',rationale:<reason>}. Match scope to recipe.region or full_image when absent. Preview may explore settings; finalization requires the current matching plan. ADOPT can attach a viewed/evaluated photo candidate to an iterative trajectory.");
    parts.push("Before any generated or SVG edit candidate, record a matching plan with avo_update_copilot_plan. For image_generator use parameters={kind:'semantic',prompt:<the exact generation prompt>}, capability='image_generator', and mask={kind:'none',rationale:<reason>}. For SVG use capability='svg_edit', kind='svg_structured', parameters={kind:'svg_structured',command:<operation>,arguments:<exact operation parameters>}. A region is a normalized x/y/width/height plan, not a materialized neural mask. Use mask=none with an honest rationale; form an SVG mask with the available geometry tools where useful. Plans are Main's revisable interpretations, not changes to the task or evaluator.");
  }
  return parts.length ? `\n${parts.join("\n")}` : "";
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equalJson(item, b[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((key) => Object.hasOwn(y, key) && equalJson(x[key], y[key]));
}
