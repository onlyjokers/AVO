import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateDraft, RunSnapshot } from "@avo/contracts";
import { assertReferenceUsage, assertTrialClaim, isCleanSourceTrial, trialEvidence } from "../src/trial-evidence.ts";

const draft = (id: string, base: string, refs: string[] = [], prompt = "Complete plan") => ({
  id, artifact_id: `image-${id}`, parent_artifact_id: base, prompt, round: 1,
  generation_input: { base_artifact_id: base, reference_artifact_ids: refs },
} as CandidateDraft);
const fixture = () => ({
  lineage_nodes: [{ id: "seed", kind: "seed", artifact_id: "source" }],
  drafts: [draft("draft-a", "source"), draft("draft-b", "source", ["image-draft-a"]), draft("draft-c", "image-draft-a")],
  comparative_decisions: [
    { id: "decision-a", draft_id: "draft-a", correctness: "fail", evaluation_frame_revision_id: "frame-1", feedback_for_main_agent: [] },
    { id: "decision-b", draft_id: "draft-b", correctness: "fail", evaluation_frame_revision_id: "frame-1", feedback_for_main_agent: [] },
    { id: "decision-c", draft_id: "draft-c", correctness: "pass", evaluation_frame_revision_id: "frame-1", feedback_for_main_agent: [] },
  ],
} as unknown as RunSnapshot);

test("Source plus generated reference cannot refute a clean Source-only strategy", () => {
  const run = fixture();
  assert.equal(isCleanSourceTrial(run, run.drafts[0]!), true);
  assert.equal(isCleanSourceTrial(run, run.drafts[1]!), false);
  assert.throws(() => assertTrialClaim(run, { kind: "clean_source_failed", draft_ids: ["draft-b"] }), /not_clean_source/);
  assert.doesNotThrow(() => assertTrialClaim(run, { kind: "clean_source_failed", draft_ids: ["draft-a"] }));
  run.comparative_decisions = [];
  assert.throws(() => assertTrialClaim(run, { kind: "clean_source_failed", draft_ids: ["draft-a"] }), /not_evaluated/);
});

test("controlled claims require a single changed factor and a shared evaluation frame", () => {
  const run = fixture();
  assert.doesNotThrow(() => assertTrialClaim(run, { kind: "base_effect", draft_ids: ["draft-a", "draft-c"] }));
  assert.doesNotThrow(() => assertTrialClaim(run, { kind: "reference_effect", draft_ids: ["draft-a", "draft-b"] }));
  run.drafts[2]!.prompt = "Different prompt";
  assert.throws(() => assertTrialClaim(run, { kind: "base_effect", draft_ids: ["draft-a", "draft-c"] }), /confounded_inputs/);
  assert.doesNotThrow(() => assertTrialClaim(run, { kind: "observational", draft_ids: ["draft-a", "draft-c"] }));
  run.comparative_decisions[1]!.evaluation_frame_revision_id = "frame-2";
  assert.throws(() => assertTrialClaim(run, { kind: "reference_effect", draft_ids: ["draft-a", "draft-b"] }), /same_frame/);
});

test("evidence retains complete replay inputs and explicitly marks unknown reference purpose", () => {
  const run = fixture();
  const evidence = trialEvidence(run);
  assert.equal(evidence[1]!.reference_inputs[0]!.kind, "generated_candidate");
  assert.equal(evidence[1]!.reference_inputs[0]!.declared_usage, null);
  assert.equal(evidence[1]!.reference_inputs[0]!.prior_correctness, "fail");
  assert.deepEqual(evidence[1]!.replay.reference_artifact_ids, ["image-draft-a"]);
  assert.equal(evidence[1]!.replay.prompt, "Complete plan");
  run.drafts[0]!.creation_method = "photo_adjustment";
  assert.equal(isCleanSourceTrial(run, run.drafts[0]!), false);
  assert.throws(() => assertTrialClaim(run, { kind: "observational", draft_ids: ["not-real"] }), /unknown_draft/);
});

test("reference-use metadata must name every selected reference exactly once", () => {
  const input = { base_artifact_id: "source", reference_artifact_ids: ["ref"] };
  assert.doesNotThrow(() => assertReferenceUsage(input));
  assert.throws(() => assertReferenceUsage({ ...input, reference_usage: [] }), /cover_selected/);
  assert.doesNotThrow(() => assertReferenceUsage({ ...input, reference_usage: [{ artifact_id: "ref", purpose: "composition", rationale: "Layout only; no pixel mask" }] }));
});
