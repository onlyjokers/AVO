import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCopilotEdit, copilotContext, copilotStateSchema, recordCopilotOutcome, updateCopilotPlan,
  type CopilotEnvironment, type CopilotOperation, type CopilotPlanInput,
} from "../src/experiment-copilot.ts";

function environment(): CopilotEnvironment {
  return {
    run_id: "run-1",
    experimental_features: { copilot_routing: true, svg_editing: true, iterative_search: false },
    public_brief: { task_id: "task-1", brief: "Change the sky; reduce overlay opacity; update text and color.", preservation: ["Keep dimensions"], checklist: [{ id: "dimensions", text: "Keep dimensions" }] },
    public_assets: [{ artifact_id: "source", kind: "image" }, { artifact_id: "doc", kind: "svg", element_ids: ["overlay", "label"] }, { artifact_id: "mask", kind: "mask" }],
    capabilities: [
      { id: "generate", route: "image_generator", operations: ["semantic", "opacity", "text", "color"], scopes: ["full_image", "region"], masks: ["none", "proposed", "public_asset"], accepts_image_base: true },
      { id: "svg", route: "svg_edit", operations: ["opacity", "text", "color", "svg_structured"], scopes: ["full_image", "elements", "region"], masks: ["none", "public_asset"], accepts_image_base: true, svg_commands: ["set_attribute"] },
    ],
  };
}

function operation(): CopilotOperation {
  return { id: "edit-1", kind: "opacity", intent: "Reduce overlay opacity", route: "svg_edit", capability: "svg", base_artifact_id: "doc", reference_artifact_ids: [], scope: { kind: "elements", element_ids: ["overlay"] }, mask: { kind: "none", rationale: "Known SVG element" }, parameters: { kind: "opacity", value: 0.4 }, rationale: "Exact parameter edit" };
}

function plan(op = operation()): CopilotPlanInput {
  return { expected_revision: 0, interpretation: "Change only the requested properties", public_brief_quotes: ["reduce overlay opacity"], ambiguities: [], delta: "Initial interpretation", operations: [op] };
}

test("deterministic opacity, text, and color use selected SVG capability", () => {
  for (const parameters of [{ kind: "opacity", value: 0.2 }, { kind: "text", value: "Hello" }, { kind: "color", value: "#aabbcc" }] as const) {
    const op = { ...operation(), kind: parameters.kind, parameters };
    const env = environment();
    const state = updateCopilotPlan(undefined, plan(op), env);
    assert.deepEqual(assertCopilotEdit(state, op, env), op);
    assert.deepEqual(copilotStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  }
});

test("semantic edits require generator, without guessing natural-language keywords", () => {
  const env = environment();
  const op: CopilotOperation = { ...operation(), kind: "semantic", parameters: { kind: "semantic", prompt: "Replace sky with clouds" }, scope: { kind: "full_image" }, base_artifact_id: "source", route: "image_generator", capability: "generate" };
  const state = updateCopilotPlan(undefined, plan(op), env);
  assert.equal(assertCopilotEdit(state, op, env)?.route, "image_generator");
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...op, route: "svg_edit", capability: "svg" }), env), /semantic_requires_generator/);
});

test("Main may choose generator for supported nonsemantic work; no forced SVG policy", () => {
  const env = environment();
  const op: CopilotOperation = { ...operation(), route: "image_generator", capability: "generate", base_artifact_id: "source", scope: { kind: "full_image" } };
  assert.equal(assertCopilotEdit(updateCopilotPlan(undefined, plan(op), env), op, env)?.route, "image_generator");
});

test("reject nonexistent or hidden assets, non-mask masks, and nonexistent SVG elements", () => {
  const env = environment();
  for (const patch of [
    { base_artifact_id: "hidden-target" },
    { reference_artifact_ids: ["nonexistent"] },
    { mask: { kind: "public_asset", artifact_id: "source" } },
    { mask: { kind: "public_asset", artifact_id: "hidden-target" } },
    { scope: { kind: "elements", element_ids: ["missing"] } },
  ] as Partial<CopilotOperation>[]) {
    assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), ...patch }), env), /copilot_invalid/);
  }
});

test("validate capability, image import support, command allowlist, scope and values", () => {
  const env = environment();
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), capability: "invented" }), env), /unsupported_capability/);
  assert.throws(() => updateCopilotPlan(undefined, plan(), { ...env, experimental_features: { copilot_routing: true } }), /svg_disabled/);
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), parameters: { kind: "text", value: "wrong" } }), env), /parameter_kind_mismatch/);
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), scope: { kind: "region", x: 0.9, y: 0, width: 0.2, height: 0.2 } }), env), /invalid_region/);
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), parameters: { kind: "opacity", value: 2 } }), env));
  const op: CopilotOperation = { ...operation(), kind: "svg_structured", parameters: { kind: "svg_structured", command: "set_attribute", arguments: { name: "fill", value: "#ff0000" } } };
  assert.ok(assertCopilotEdit(updateCopilotPlan(undefined, plan(op), env), op, env));
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...op, parameters: { ...op.parameters, kind: "svg_structured", command: "exec", arguments: {} } }), env), /unsupported_svg_command/);
  env.capabilities[1]!.accepts_image_base = false;
  assert.throws(() => updateCopilotPlan(undefined, plan({ ...operation(), base_artifact_id: "source", scope: { kind: "full_image" } }), env), /unsupported_image_base/);
});

test("proposed masks are plans, not falsely advertised executed masks", () => {
  const env = environment();
  const op: CopilotOperation = { ...operation(), kind: "semantic", route: "image_generator", capability: "generate", parameters: { kind: "semantic", prompt: "Change the sky" }, base_artifact_id: "source", scope: { kind: "region", x: 0, y: 0, width: 1, height: 0.5 }, mask: { kind: "proposed", description: "Segment sky" } };
  const state = updateCopilotPlan(undefined, plan(op), env);
  assert.throws(() => assertCopilotEdit(state, op, env), /mask_not_materialized/);
  const ready: CopilotOperation = { ...op, mask: { kind: "public_asset", artifact_id: "mask" } };
  const revised = updateCopilotPlan(state, { ...plan(ready), expected_revision: 1, delta: "Materialized public mask" }, env);
  assert.ok(assertCopilotEdit(revised, ready, env));
  env.capabilities[0]!.masks = ["none"];
  assert.throws(() => assertCopilotEdit(revised, ready, env), /unsupported_capability/);
});

test("immutable revisions, public-brief binding, strict input, and execution matching", () => {
  const env = environment();
  const before = structuredClone(env);
  const state = updateCopilotPlan(undefined, plan(), env);
  const snapshot = structuredClone(state);
  const op = { ...operation(), parameters: { kind: "opacity" as const, value: 0.1 } };
  assert.throws(() => assertCopilotEdit(state, op, env), /edit_not_in_current_plan/);
  assert.throws(() => assertCopilotEdit(undefined, operation(), env), /plan_required/);
  assert.throws(() => updateCopilotPlan(state, plan(), env), /stale_revision/);
  const revised = updateCopilotPlan(state, { ...plan(op), expected_revision: 1, delta: "Reduce further after observation" }, env);
  assert.equal(revised.revisions.length, 2);
  assert.deepEqual(state, snapshot);
  assert.deepEqual(env, before);
  assert.throws(() => updateCopilotPlan(undefined, { ...plan(), checklist: [] }, env));
  assert.throws(() => updateCopilotPlan(undefined, { ...plan(), public_brief_quotes: ["hidden reference says"] }, env), /quote_not_in_public_brief/);
  assert.throws(() => updateCopilotPlan(undefined, { ...plan(), operations: [operation(), operation()] }, env), /duplicate_operation/);
  assert.throws(() => copilotContext(state, { ...env, run_id: "other-run" }), /context_mismatch/);
  env.public_brief.preservation.push("New constraint");
  assert.throws(() => copilotContext(state, env), /context_mismatch/);
});

test("outcomes are revision-linked runtime facts, idempotent, not candidate acceptance", () => {
  const env = environment();
  const state = updateCopilotPlan(undefined, plan(), env);
  env.public_assets.push({ artifact_id: "result", kind: "image" });
  const outcome = { execution_id: "call-1", revision: 1, operation_id: "edit-1", status: "succeeded", artifact_id: "result", draft_id: "draft-1", observation: "Rendered candidate; not evaluated" };
  const recorded = recordCopilotOutcome(state, outcome, env);
  assert.equal(state.outcomes.length, 0);
  assert.equal(recorded.outcomes.length, 1);
  assert.deepEqual(recordCopilotOutcome(recorded, outcome, env), recorded);
  assert.throws(() => recordCopilotOutcome(recorded, { ...outcome, observation: "Different" }, env), /conflicting_outcome/);
  assert.throws(() => recordCopilotOutcome(state, { ...outcome, revision: 99 }, env), /unknown_outcome_operation/);
  assert.throws(() => recordCopilotOutcome(state, { ...outcome, artifact_id: "hidden-target" }, env), /invalid_outcome_artifact/);
  assert.throws(() => recordCopilotOutcome(state, { ...outcome, draft_id: undefined }, env), /invalid_success_outcome/);
  assert.throws(() => recordCopilotOutcome(state, { ...outcome, accepted: true }, env));
  const failed = recordCopilotOutcome(state, { execution_id: "failed", revision: 1, operation_id: "edit-1", status: "failed", error: "render_failed", observation: "No candidate produced" }, env);
  assert.equal(failed.outcomes[0]?.status, "failed");
});

test("baseline is no-op even with stale state; context copies never expose extra fields", () => {
  const env = environment();
  const state = updateCopilotPlan(undefined, plan(), env);
  const { experimental_features: _features, ...off } = env;
  assert.equal(copilotContext(state, off), undefined);
  assert.equal(assertCopilotEdit(undefined, { arbitrary: true }, off), undefined);
  assert.equal(recordCopilotOutcome(state, {}, off), state);
  assert.throws(() => updateCopilotPlan(undefined, plan(), off), /copilot_disabled/);
  Object.assign(env.public_assets[0]!, { path: "/private/path", hidden_target: "secret" });
  const context = copilotContext(state, env)!;
  assert.ok(!JSON.stringify(context).includes("secret"));
  context.public_brief.preservation.push("changed");
  context.plan!.interpretation = "changed";
  assert.equal(env.public_brief.preservation.length, 1);
  assert.notEqual(state.revisions[0]?.interpretation, "changed");
});

test("structured SVG parameters remain JSON-persistable and key-order independent", () => {
  const env = environment();
  const op: CopilotOperation = { ...operation(), kind: "svg_structured", parameters: { kind: "svg_structured", command: "set_attribute", arguments: { name: "fill", value: "#ffffff", nested: { a: 1, b: 2 } } } };
  const state = updateCopilotPlan(undefined, plan(op), env);
  const reordered: CopilotOperation = { ...op, parameters: { kind: "svg_structured", command: "set_attribute", arguments: { nested: { b: 2, a: 1 }, value: "#ffffff", name: "fill" } } };
  assert.ok(assertCopilotEdit(state, reordered, env));
  for (const invalid of [undefined, () => 1, Number.POSITIVE_INFINITY, 1n]) {
    assert.throws(() => updateCopilotPlan(undefined, { ...plan(op), operations: [{ ...op, parameters: { kind: "svg_structured", command: "set_attribute", arguments: { invalid } } }] }, env));
  }
  const context = copilotContext(state, env)!;
  assert.ok(context.instruction.includes("no automatic semantic segmentation"));
});
