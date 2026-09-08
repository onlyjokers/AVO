import { createHash } from "node:crypto";
import { z } from "zod";
import { photoRecipeSchema } from "./photo-editor.ts";

const text = z.string().min(1).max(8_000).refine((value) => value.trim().length > 0);
const id = z.string().min(1).max(256);
const kind = z.enum(["semantic", "opacity", "text", "color", "svg_structured", "photo_adjustment"]);
const route = z.enum(["svg_edit", "image_generator", "photo_adjustment"]);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue),
]));
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full_image") }).strict(),
  z.object({ kind: z.literal("region"), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict(),
  z.object({ kind: z.literal("elements"), element_ids: z.array(id).min(1).max(100) }).strict(),
]);
const mask = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), rationale: text }).strict(),
  z.object({ kind: z.literal("public_asset"), artifact_id: id }).strict(),
  z.object({ kind: z.literal("proposed"), description: text }).strict(),
]);

export const copilotOperationSchema = z.object({
  id,
  kind,
  intent: text,
  route,
  capability: id,
  base_artifact_id: id,
  reference_artifact_ids: z.array(id).max(20),
  scope,
  mask,
  parameters: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("semantic"), prompt: text }).strict(),
    z.object({ kind: z.literal("opacity"), value: z.number().min(0).max(1) }).strict(),
    z.object({ kind: z.literal("text"), value: text }).strict(),
    z.object({ kind: z.literal("color"), value: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/) }).strict(),
    z.object({ kind: z.literal("svg_structured"), command: id, arguments: z.record(jsonValue) }).strict(),
    z.object({ kind: z.literal("photo_adjustment"), recipe: photoRecipeSchema }).strict(),
  ]),
  rationale: text,
}).strict();

export const copilotPlanInputSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  interpretation: text,
  public_brief_quotes: z.array(text).min(1).max(20),
  ambiguities: z.array(z.object({ question: text, interpretation: text, rationale: text }).strict()).max(20),
  delta: text,
  operations: z.array(copilotOperationSchema).min(1).max(20),
}).strict();

const briefSchema = z.object({
  task_id: id,
  brief: text,
  preservation: z.array(text),
  checklist: z.array(z.object({ id, text }).strict()),
}).strict();

export type CopilotPublicBrief = z.infer<typeof briefSchema>;
export type CopilotOperation = z.infer<typeof copilotOperationSchema>;
export type CopilotPlanInput = z.infer<typeof copilotPlanInputSchema>;
export type CopilotEnvironment = {
  run_id: string;
  experimental_features?: { copilot_routing?: boolean; svg_editing?: boolean; iterative_search?: boolean; photo_adjustments?: boolean | undefined };
  /** Construct from public task/checklist only, never a raw RunSnapshot or verifier input. */
  public_brief: CopilotPublicBrief;
  public_assets: Array<{ artifact_id: string; kind: "image" | "svg" | "mask"; element_ids?: string[] }>;
  /** Server-owned live adapter inventory, not declarations supplied by Main. */
  capabilities: Array<{
    id: string;
    route: CopilotOperation["route"];
    operations: CopilotOperation["kind"][];
    scopes: CopilotOperation["scope"]["kind"][];
    masks: CopilotOperation["mask"]["kind"][];
    accepts_image_base: boolean;
    svg_commands?: string[];
  }>;
};

const revisionSchema = copilotPlanInputSchema.extend({ revision: z.number().int().positive() });
export const copilotOutcomeSchema = z.object({
  execution_id: id,
  revision: z.number().int().positive(),
  operation_id: id,
  status: z.enum(["succeeded", "failed"]),
  artifact_id: id.optional(),
  draft_id: id.optional(),
  error: text.optional(),
  observation: text,
}).strict();
export type CopilotOutcome = z.infer<typeof copilotOutcomeSchema>;

export const copilotStateSchema = z.object({
  version: z.literal(1),
  run_id: id,
  brief_hash: id,
  revisions: z.array(revisionSchema),
  outcomes: z.array(copilotOutcomeSchema),
}).strict();
export type CopilotState = z.infer<typeof copilotStateSchema>;

function fail(reason: string): never { throw new Error(`copilot_${reason}`); }

function briefHash(environment: CopilotEnvironment): string {
  return createHash("sha256").update(JSON.stringify(briefSchema.parse(environment.public_brief))).digest("hex");
}

function enabled(environment: CopilotEnvironment): boolean {
  return environment.experimental_features?.copilot_routing === true;
}

function readState(state: CopilotState | undefined, environment: CopilotEnvironment): CopilotState {
  const hash = briefHash(environment);
  if (!state) return { version: 1, run_id: environment.run_id, brief_hash: hash, revisions: [], outcomes: [] };
  const parsed = copilotStateSchema.parse(state);
  if (parsed.run_id !== environment.run_id || parsed.brief_hash !== hash) fail("context_mismatch");
  if (parsed.revisions.some((item, index) => item.revision !== index + 1 || item.expected_revision !== index)) fail("invalid_history");
  return parsed;
}

function validateOperation(operation: CopilotOperation, environment: CopilotEnvironment, executing: boolean): void {
  if (operation.kind !== operation.parameters.kind) fail("parameter_kind_mismatch");
  if (operation.kind === "semantic" && operation.route !== "image_generator") fail("semantic_requires_generator");
  if (operation.kind === "svg_structured" && operation.route !== "svg_edit") fail("svg_requires_svg_route");
  if (operation.kind === "photo_adjustment" && operation.route !== "photo_adjustment") fail("photo_requires_photo_route");
  if (operation.route === "photo_adjustment") {
    if (!environment.experimental_features?.photo_adjustments) fail("photo_disabled");
    if (operation.parameters.kind !== "photo_adjustment" || operation.reference_artifact_ids.length) fail("photo_invalid_inputs");
    const region = operation.parameters.recipe.region;
    if (region ? operation.scope.kind !== "region" || ["x", "y", "width", "height"].some((key) =>
      region[key as "x"] !== (operation.scope as { x: number; y: number; width: number; height: number })[key as "x"])
      : operation.scope.kind !== "full_image") fail("photo_scope_mismatch");
  }
  if (operation.route === "svg_edit" && environment.experimental_features?.svg_editing !== true) fail("svg_disabled");
  const capability = environment.capabilities.find((item) => item.id === operation.capability && item.route === operation.route);
  if (!capability || !capability.operations.includes(operation.kind)
    || !capability.scopes.includes(operation.scope.kind) || !capability.masks.includes(operation.mask.kind)) fail("unsupported_capability");
  const asset = environment.public_assets.find((item) => item.artifact_id === operation.base_artifact_id);
  if (!asset || asset.kind === "mask") fail("invalid_public_base");
  if (asset.kind === "image" && !capability.accepts_image_base) fail("unsupported_image_base");
  for (const reference of operation.reference_artifact_ids) {
    if (!environment.public_assets.some((item) => item.artifact_id === reference && item.kind !== "mask")) fail("invalid_public_reference");
  }
  if (operation.scope.kind === "elements") {
    if (asset.kind !== "svg" || operation.scope.element_ids.some((element) => !asset.element_ids?.includes(element))) fail("invalid_svg_elements");
  }
  if (operation.scope.kind === "region" && (operation.scope.x + operation.scope.width > 1 || operation.scope.y + operation.scope.height > 1)) fail("invalid_region");
  if (operation.mask.kind === "public_asset") {
    const maskId = operation.mask.artifact_id;
    if (!environment.public_assets.some((item) => item.artifact_id === maskId && item.kind === "mask")) fail("invalid_public_mask");
  }
  if (executing && operation.mask.kind === "proposed") fail("mask_not_materialized");
  if (operation.parameters.kind === "svg_structured" && !capability.svg_commands?.includes(operation.parameters.command)) fail("unsupported_svg_command");
}

/** Main's tool writes a complete revision, never patches the public task or checklist. */
export function updateCopilotPlan(state: CopilotState | undefined, input: unknown, environment: CopilotEnvironment): CopilotState {
  if (!enabled(environment)) fail("disabled");
  const current = readState(state, environment);
  const plan = copilotPlanInputSchema.parse(input);
  if (plan.expected_revision !== current.revisions.length) fail("stale_revision");
  if (new Set(plan.operations.map((operation) => operation.id)).size !== plan.operations.length) fail("duplicate_operation");
  if (plan.public_brief_quotes.some((quote) => !environment.public_brief.brief.includes(quote))) fail("quote_not_in_public_brief");
  for (const operation of plan.operations) validateOperation(operation, environment, false);
  return { ...current, revisions: [...current.revisions, { ...plan, revision: current.revisions.length + 1 }] };
}

/** Call inside the existing broker queue, immediately before each actual edit. */
export function assertCopilotEdit(state: CopilotState | undefined, input: unknown, environment: CopilotEnvironment): CopilotOperation | undefined {
  if (!enabled(environment)) return undefined;
  const current = readState(state, environment);
  const plan = current.revisions.at(-1);
  if (!plan) fail("plan_required");
  const operation = copilotOperationSchema.parse(input);
  const planned = plan.operations.find((item) => item.id === operation.id);
  if (!planned || !sameJson(planned, operation)) fail("edit_not_in_current_plan");
  validateOperation(operation, environment, true);
  return operation;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

/** Runtime-owned facts only: success means an artifact, never Verifier acceptance. */
export function recordCopilotOutcome(state: CopilotState, input: unknown, environment: CopilotEnvironment): CopilotState {
  if (!enabled(environment)) return state;
  const current = readState(state, environment);
  const outcome = copilotOutcomeSchema.parse(input);
  const plan = current.revisions.find((item) => item.revision === outcome.revision);
  if (!plan?.operations.some((item) => item.id === outcome.operation_id)) fail("unknown_outcome_operation");
  if (outcome.status === "succeeded" && (!outcome.artifact_id || !outcome.draft_id || outcome.error)) fail("invalid_success_outcome");
  if (outcome.status === "failed" && (!outcome.error || outcome.artifact_id || outcome.draft_id)) fail("invalid_failure_outcome");
  if (outcome.artifact_id && !environment.public_assets.some((item) => item.artifact_id === outcome.artifact_id && item.kind === "image")) fail("invalid_outcome_artifact");
  const existing = current.outcomes.find((item) => item.execution_id === outcome.execution_id);
  if (existing) {
    if (!sameJson(existing, outcome)) fail("conflicting_outcome");
    return current;
  }
  return { ...current, outcomes: [...current.outcomes, outcome] };
}

/** Add to initial Main context and avo_get_state; omit entirely for baseline. */
export function copilotContext(state: CopilotState | undefined, environment: CopilotEnvironment) {
  if (!enabled(environment)) return undefined;
  const current = readState(state, environment);
  return {
    public_brief: briefSchema.parse(environment.public_brief),
    revision: current.revisions.length,
    plan: current.revisions.at(-1) ?? null,
    outcomes: current.outcomes.slice(-5),
    public_assets: environment.public_assets.map((asset) => ({ artifact_id: asset.artifact_id, kind: asset.kind, ...(asset.element_ids ? { element_ids: [...asset.element_ids] } : {}) })),
    capabilities: environment.capabilities.filter((capability) => capability.route !== "svg_edit" || environment.experimental_features?.svg_editing === true).map((capability) => ({
      id: capability.id, route: capability.route, operations: [...capability.operations], scopes: [...capability.scopes], masks: [...capability.masks], accepts_image_base: capability.accepts_image_base,
      ...(capability.svg_commands ? { svg_commands: [...capability.svg_commands] } : {}),
    })),
    instruction: "Use avo_update_copilot_plan to record or revise your public-brief interpretation, delta, scope/mask and chosen operation before edits. Read, inspect, revise, or stop autonomously; no fixed stage order. Interpretations are hypotheses, not new requirements. A proposed mask must be materialized as a public asset before execution. SVG masks use Agent-authored geometry or supplied public alpha; no automatic semantic segmentation is available. Verifier alone judges candidates against the unchanged task.",
  };
}
