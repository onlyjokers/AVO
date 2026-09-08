import { createHash } from "node:crypto";
import { trialClaimSchema, type CandidateDraft, type GenerationInput, type RunSnapshot } from "@avo/contracts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const method = (draft: CandidateDraft) => draft.creation_method ?? "image_provider";
const sourceId = (run: RunSnapshot) => run.lineage_nodes.find((node) => node.kind === "seed")?.artifact_id;

export function isCleanSourceTrial(run: RunSnapshot, draft: CandidateDraft) {
  return Boolean(sourceId(run)) && method(draft) === "image_provider"
    && draft.parent_artifact_id === sourceId(run) && draft.generation_input.reference_artifact_ids.length === 0;
}

export function assertReferenceUsage(input: GenerationInput) {
  if (input.reference_usage === undefined) return;
  const declared = input.reference_usage.map((item) => item.artifact_id);
  const refs = [...new Set(input.reference_artifact_ids)];
  if (new Set(declared).size !== declared.length || declared.length !== refs.length
    || declared.some((id) => !refs.includes(id))) throw new Error("reference_usage_must_cover_selected_references_exactly");
}

export function trialDifferences(a: CandidateDraft, b: CandidateDraft) {
  return [
    ...(!same(a.parent_artifact_id, b.parent_artifact_id) ? ["base"] : []),
    ...(!same(a.generation_input.reference_artifact_ids, b.generation_input.reference_artifact_ids) ? ["references"] : []),
    ...(a.prompt !== b.prompt ? ["prompt"] : []),
    ...(method(a) !== method(b) ? ["method"] : []),
    ...(!same(a.photo_edit?.recipe, b.photo_edit?.recipe) ? ["photo_recipe"] : []),
  ];
}

export function assertTrialClaim(run: RunSnapshot, value: unknown) {
  const claim = trialClaimSchema.parse(value);
  if (new Set(claim.draft_ids).size !== claim.draft_ids.length) throw new Error("trial_claim_duplicate_drafts");
  const drafts = claim.draft_ids.map((id) => {
    const draft = run.drafts.find((item) => item.id === id);
    if (!draft) throw new Error("trial_claim_unknown_draft");
    return draft;
  });
  if (claim.kind === "clean_source_tested" || claim.kind === "clean_source_failed") {
    if (!drafts.every((draft) => isCleanSourceTrial(run, draft))) throw new Error("trial_claim_not_clean_source:references_or_generated_base_present");
    if (claim.kind === "clean_source_failed" && !drafts.every((draft) =>
      run.comparative_decisions.findLast((decision) => decision.draft_id === draft.id)?.correctness === "fail")) {
      throw new Error("trial_claim_clean_source_failure_not_evaluated");
    }
  }
  if (claim.kind === "base_effect" || claim.kind === "reference_effect") {
    if (drafts.length !== 2 || drafts.some((draft) => method(draft) !== "image_provider")) throw new Error("trial_claim_requires_two_generation_trials");
    const variable = claim.kind === "base_effect" ? "base" : "references";
    if (!same(trialDifferences(drafts[0]!, drafts[1]!), [variable])) throw new Error("trial_claim_confounded_inputs:use_observational_claim");
    const decisions = drafts.map((draft) => run.comparative_decisions.findLast((decision) => decision.draft_id === draft.id));
    if (!decisions[0] || !decisions[1] || decisions[0].evaluation_frame_revision_id !== decisions[1].evaluation_frame_revision_id) {
      throw new Error("trial_claim_requires_same_frame_evaluations");
    }
  }
  return claim;
}

/** Derived from immutable candidate inputs, not from the model's narrative memory. */
export function trialEvidence(run: RunSnapshot, drafts = run.drafts) {
  return drafts.map((draft) => ({
    draft_id: draft.id, artifact_id: draft.artifact_id, attempt: draft.round,
    method: method(draft), base_artifact_id: draft.parent_artifact_id,
    clean_source_generation: isCleanSourceTrial(run, draft),
    prompt: draft.prompt, prompt_sha256: createHash("sha256").update(draft.prompt).digest("hex"),
    reference_inputs: draft.generation_input.reference_artifact_ids.map((id) => {
      const reference = run.drafts.find((item) => item.artifact_id === id);
      const decision = reference && run.comparative_decisions.findLast((item) => item.draft_id === reference.id);
      return { artifact_id: id, kind: id === sourceId(run) ? "source" : reference ? "generated_candidate" : "public_reference",
        declared_usage: draft.generation_input.reference_usage?.find((item) => item.artifact_id === id) ?? null,
        prior_correctness: decision?.correctness ?? "not_assessed",
        risk: reference ? "Generated reference may reintroduce defects even when base is Source; intended use is not a pixel mask." : null };
    }),
    photo_edit: draft.photo_edit ?? null,
    assessments: run.comparative_decisions.filter((item) => item.draft_id === draft.id).map((item) => ({
      id: item.id, frame: item.evaluation_frame_revision_id, correctness: item.correctness,
      preference: item.preference, recommendation: item.recommendation, feedback: item.feedback_for_main_agent,
    })),
    replay: { base_artifact_id: draft.parent_artifact_id, prompt: draft.prompt,
      reference_artifact_ids: draft.generation_input.reference_artifact_ids,
      reference_usage: draft.generation_input.reference_usage ?? null,
      photo_recipe: draft.photo_edit?.recipe ?? null },
  }));
}
