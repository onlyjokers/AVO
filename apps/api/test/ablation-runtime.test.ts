import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRoundContext, AgentToolbox } from "@avo/core";
import type { RunSnapshot } from "@avo/contracts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import type { SvgEditor } from "../src/svg-editor.ts";
import { copilotEnvironment, plannedEdit } from "../src/experiment-runtime.ts";
import { updateCopilotPlan, type CopilotOperation } from "../src/experiment-copilot.ts";
import { AVO_MCP_TOOL_ALLOWLIST, avoToolTransportContext } from "../src/codex-provider.ts";
import { allowedAvoTools } from "../src/experimental-tools.ts";
import { ablationFeatures } from "../src/ablation-presets.ts";
import { photoRecipeSchema } from "../src/photo-editor.ts";

test("Deferred transport schemas cover only the exact authorized tools in all five arms", () => {
  for (const features of [
    { svg_editing: false, iterative_search: false, copilot_routing: false },
    { svg_editing: true, iterative_search: false, copilot_routing: false },
    { svg_editing: true, iterative_search: true, copilot_routing: false },
    { svg_editing: true, iterative_search: false, copilot_routing: true },
    { svg_editing: true, iterative_search: true, copilot_routing: true },
  ]) {
    const names = allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features);
    const tools = Object.fromEntries(names.map(name => [name, { name, inputSchema: { type: "object", properties: { test: { type: "string" } } } }]));
    const inventory = { data: [{ name: "avo", tools }] };
    const context = avoToolTransportContext(inventory, features);
    const schemas = JSON.parse(context.split("\n")[1]!);
    assert.deepEqual(schemas.map((tool: { name: string }) => tool.name), [...names].sort());
    assert.deepEqual(schemas[0].inputSchema, tools[names[0]!]!.inputSchema);
    assert.throws(() => avoToolTransportContext({ data: [{ name: "avo", tools: { ...tools, read_file: {} } }] }, features), /inventory_violation/);
  }
});

test("all four photo treatments expose real tonal tools, while the control has none", () => {
  const arms = ablationFeatures("photo");
  assert.equal(arms.length, 5);
  assert.deepEqual(allowedAvoTools([], arms[0]), []);
  for (const [index, features] of arms.entries()) if (index > 0) {
    const names = allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features);
    assert.equal(features.svg_editing, false);
    assert.ok(names.includes("avo_photo_preview"));
    assert.ok(names.includes("avo_photo_finalize"));
    assert.ok(names.includes("avo_view_detail"));
    assert.equal(names.includes("avo_generate_image"), !features.iterative_search);
    assert.equal(names.includes("avo_update_copilot_plan"), features.copilot_routing);
    const tools = Object.fromEntries(names.map(name => [name, { name, inputSchema: { type: "object", properties: {} } }]));
    assert.doesNotThrow(() => avoToolTransportContext({ data: [{ name: "avo", tools }] }, features));
  }
});

function fixture() {
  const run = {
    id: "run-test", status: "running", config: { max_generations: 24, max_generations_per_round: 24, max_wall_time_ms: 5_400_000, experimental_features: { svg_editing: true, copilot_routing: true, iterative_search: false } },
    generation_count: 0, drafts: [], evaluations: [], active_variation_attempt: 1, lineage_nodes: [{ kind: "seed", id: "seed", artifact_id: "source" }],
  } as unknown as RunSnapshot;
  const context = { run, task: { id: "task", user_brief: "Adjust color and text.", source_artifact_id: "source", references: [{ artifact_id: "reference" }], preservation_contract: {} }, checklist: { requirements: [] } } as unknown as AgentRoundContext;
  const tools = {
    getRunSnapshot: () => run, recordAgentRuntime: async () => {}, setStepDeadline: async () => {},
    recordExperimentState: async (kind: string, state: unknown) => { run.experimental_state = { ...run.experimental_state, [kind]: state }; },
  } as unknown as AgentToolbox;
  const operation: CopilotOperation = {
    id: "op", kind: "svg_structured", intent: "Adjust color", route: "svg_edit", capability: "svg_edit", base_artifact_id: "source", reference_artifact_ids: [],
    scope: { kind: "full_image" }, mask: { kind: "none", rationale: "Use existing image" },
    parameters: { kind: "svg_structured", command: "apply_color_overlay", arguments: { target: "base", color: "#ffffff", opacity: 0.1 } }, rationale: "Deterministic edit",
  };
  const plan = (revision = 0, op = operation) => ({ expected_revision: revision, interpretation: "Change requested properties", public_brief_quotes: ["Adjust color"], ambiguities: [], delta: "Initial plan", operations: [op] });
  return { run, context, tools, operation, plan };
}

test("Copilot matches actual generation references, not a plan against itself", () => {
  const { run, tools, context, operation, plan } = fixture();
  const op: CopilotOperation = { ...operation, kind: "semantic", route: "image_generator", capability: "image_generator", parameters: { kind: "semantic", prompt: "Do a semantic edit" } };
  run.experimental_state = { copilot: updateCopilotPlan(undefined, plan(0, op), copilotEnvironment(context, tools)) };
  assert.throws(() => plannedEdit(context, tools, { route: "image_generator", base: "source", prompt: "Do a semantic edit", references: ["reference"] }), /matching_plan/);
  assert.equal(plannedEdit(context, tools, { route: "image_generator", base: "source", prompt: "Do a semantic edit", references: [] })?.revision, 1);
});

test("Copilot photo plans validate actual recipe, region, public inputs and enabled adapter", () => {
  const { run, tools, context, operation, plan } = fixture();
  run.config.experimental_features!.photo_adjustments = true;
  run.config.experimental_features!.svg_editing = false;
  const recipe = photoRecipeSchema.parse({ exposure_ev: 0.3 });
  const op: CopilotOperation = { ...operation, kind: "photo_adjustment", route: "photo_adjustment", capability: "photo_adjustment",
    parameters: { kind: "photo_adjustment", recipe } };
  run.experimental_state = { copilot: updateCopilotPlan(undefined, plan(0, op), copilotEnvironment(context, tools)) };
  assert.equal(plannedEdit(context, tools, { route: "photo_adjustment", base: "source", parameters: { exposure_ev: 0.3 }, references: [] })?.revision, 1);
  assert.throws(() => plannedEdit(context, tools, { route: "photo_adjustment", base: "source", parameters: { exposure_ev: 0.4 }, references: [] }), /matching_plan/);
  assert.throws(() => updateCopilotPlan(undefined, plan(0, { ...op, reference_artifact_ids: ["reference"] }), copilotEnvironment(context, tools)), /photo_invalid_inputs/);
  assert.throws(() => updateCopilotPlan(undefined, plan(0, { ...op, scope: { kind: "region", x: 0, y: 0, width: 0.5, height: 0.5 } }), copilotEnvironment(context, tools)), /scope_mismatch/);
});

test("SVG plan bindings are per document and stale plans fail before materialization", async () => {
  const { run, tools, context, operation, plan } = fixture();
  let candidateCalls = 0, revision = 1;
  const svg = {
    documentState: async () => ({ parent: "source", revision, references: [] }),
    edit: async () => ({ document_id: "doc-a", revision: ++revision }),
    finalize: async () => { candidateCalls++; return { artifact_id: "result", draft_id: "draft" }; },
    closeRun: async () => {},
  } as unknown as SvgEditor;
  const broker = new AgentToolBroker({ svg });
  const close = broker.register("test", tools, context);
  try {
    await broker.invoke("test", "avo_update_copilot_plan", { plan: plan() });
    await broker.invoke("test", "avo_svg_edit", { document_id: "doc-a", operation: "apply_color_overlay", parameters: JSON.stringify((operation.parameters as { arguments: unknown }).arguments) });
    await assert.rejects(broker.invoke("test", "avo_svg_finalize", { document_id: "doc-b", description: "wrong doc" }), /edit_plan_required/);
    await broker.invoke("test", "avo_update_copilot_plan", { plan: plan(1, { ...operation, id: "new-op" }) });
    await assert.rejects(broker.invoke("test", "avo_svg_finalize", { document_id: "doc-a", description: "stale plan" }), /plan_stale/);
    assert.equal(candidateCalls, 0);
    assert.equal(run.generation_count, 0);
  } finally { close(); }
});

test("a failed SVG operation records failure without authorizing finalize", async () => {
  const { run, tools, context, operation, plan } = fixture();
  const svg = {
    documentState: async () => ({ parent: "source", revision: 1, references: [] }),
    edit: async () => { throw new Error("render_failed"); }, closeRun: async () => {},
  } as unknown as SvgEditor;
  const broker = new AgentToolBroker({ svg });
  const close = broker.register("test", tools, context);
  try {
    await broker.invoke("test", "avo_update_copilot_plan", { plan: plan() });
    await assert.rejects(broker.invoke("test", "avo_svg_edit", { document_id: "doc", operation: "apply_color_overlay", parameters: JSON.stringify((operation.parameters as { arguments: unknown }).arguments) }), /render_failed/);
    const state = run.experimental_state!.copilot as { outcomes: Array<{ status: string; revision: number }> };
    assert.equal(state.outcomes[0]?.status, "failed");
    assert.equal(state.outcomes[0]?.revision, 1);
    await assert.rejects(broker.invoke("test", "avo_svg_finalize", { document_id: "doc", description: "no successful edit" }), /edit_plan_required/);
  } finally { close(); }
});
