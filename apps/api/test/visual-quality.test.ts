import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationFrameRevision } from "@avo/contracts";
import { validateComparisonPayload, validateQualityRepair } from "../src/http-providers.ts";

const frame = { axes: [{ id: "texture", importance: "blocker" }] } as EvaluationFrameRevision;
const acceptable = { delivery_status: "acceptable", defects: [] };
const payload = {
  correctness: "pass", incumbent_correctness: "pass", winner: "A", target_progress: "improved",
  candidate_quality: acceptable, incumbent_quality: acceptable,
  axis_judgments: [{ axis_id: "texture", verdict: "pass", evidence: "Visible natural texture" }],
  confidence: 0.9, feedback_for_main_agent: [], private_feedback: [],
};

test("inherited defects cannot be accepted merely because they were not introduced this step", () => {
  const quality = { delivery_status: "unacceptable", defects: [{
    region: "road", description: "Repeated embossed texture", origin: "inherited", severity: "blocker", axis_ids: ["texture"],
  }] };
  assert.throws(() => validateComparisonPayload({ ...payload, candidate_quality: quality }, frame), /unresolved_defect_violates_blocker_axis/);
  assert.throws(() => validateComparisonPayload({ ...payload, candidate_quality: { ...quality, delivery_status: "acceptable" } }, frame), /unresolved_defect_violates_blocker_axis/);
  const result = validateComparisonPayload({ ...payload, correctness: "fail", candidate_quality: quality,
    axis_judgments: [{ axis_id: "texture", verdict: "fail", evidence: "Unresolved inherited texture violation" }],
  }, frame);
  assert.equal(result.winner, "A", "relative improvement can remain available in Archive without a Commit");
  assert.equal(result.correctness, "fail");
});

test("Qwen live-review regression: calling inherited texture major cannot bypass a blocker axis", () => {
  const quality = { delivery_status: "acceptable", defects: [{
    region: "road", description: "Repeated synthetic texture inherited from Parent, not repaired this step",
    origin: "inherited", severity: "major", axis_ids: ["texture"],
  }] };
  assert.throws(() => validateComparisonPayload({ ...payload, candidate_quality: quality }, frame), /unresolved_defect_violates_blocker_axis/);
  assert.throws(() => validateComparisonPayload({ ...payload, incumbent_quality: quality }, frame), /incumbent_unresolved_defect/);
  assert.throws(() => validateQualityRepair({ ...payload, candidate_quality: quality }, payload, frame), /repair_cannot_erase/);
  assert.throws(() => validateComparisonPayload({ ...payload, correctness: "fail", candidate_quality: { ...quality, delivery_status: "unacceptable" } }, frame), /defect_conflicts_with_axis_pass/);
});

test("quality status must be grounded in current axes and checked for both images", () => {
  assert.equal(validateComparisonPayload(payload, frame).correctness, "pass");
  assert.throws(() => validateComparisonPayload({ ...payload, incumbent_quality: { delivery_status: "uncertain", defects: [] } }, frame), /incumbent_correctness_conflicts/);
  assert.throws(() => validateComparisonPayload({ ...payload, candidate_quality: undefined }, frame));
  assert.throws(() => validateComparisonPayload({ ...payload, candidate_quality: {
    delivery_status: "acceptable", defects: [{ region: "sky", description: "grain", origin: "new", severity: "minor", axis_ids: ["invented"] }],
  } }, frame), /unknown_axis/);
});
