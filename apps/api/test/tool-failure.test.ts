import assert from "node:assert/strict";
import test from "node:test";
import { toolFailureDiagnostic } from "../src/tool-failure.ts";
import { parseIterativeAction, iterativeWireSchema } from "../src/experiment-iterative.ts";

test("iterative action accepts JSON string transport and object transport without relaxing domain validation", () => {
  const action = { action: "FRESH_START", trajectory: "A", strategy: "Change mountains", prompt: "Complete prompt", rationale: "Test clean base", reference_artifact_ids: [] };
  assert.deepEqual(parseIterativeAction(iterativeWireSchema.parse(JSON.stringify(action))), parseIterativeAction(iterativeWireSchema.parse(action)));
  assert.throws(() => parseIterativeAction(JSON.stringify({ ...action, action: "INVENTED" })));
  assert.throws(() => parseIterativeAction(JSON.stringify({ ...action, file_path: "/outside" })));
});

test("failure diagnostics retain call linkage and schema inputs without leaking credentials", () => {
  const result = toolFailureDiagnostic({ id: "call-test", arguments: JSON.stringify({ action: { action: "FRESH_START" }, api_key: "sk-sp-sensitive" }),
    error: { message: "Failed with Bearer private-value", detail: "sk-ws-private" } });
  const text = JSON.stringify(result);
  assert.equal(result.call_id, "call-test");
  assert.match(text, /FRESH_START/);
  assert.doesNotMatch(text, /sensitive|private-value|sk-ws-private/);
  assert.doesNotMatch(JSON.stringify(toolFailureDiagnostic({ arguments: '{"password":"opaque-secret' })), /opaque-secret/);
  assert.ok(JSON.stringify(toolFailureDiagnostic({ result: Array.from({ length: 30 }, () => "x".repeat(4000)) })).length < 12_000);
});
