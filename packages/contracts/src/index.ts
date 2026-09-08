import { z } from "zod";

export const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const isoDateSchema = z.string().datetime();

export const artifactSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().nonnegative(),
  original_name: z.string().min(1).max(512),
  created_at: isoDateSchema,
});

export type Artifact = z.infer<typeof artifactSchema>;

export const taskReferenceSchema = z.object({
  artifact_id: artifactSchema.shape.id,
  caption: z.string().max(2_000).optional(),
});

export const requirementSchema = z.object({
  id: idSchema,
  statement: z.string().min(1),
  severity: z.enum(["blocker", "major", "minor"]),
});

export const requirementChecklistSchema = z.object({
  version: z.literal(1),
  requirements: z.array(requirementSchema).min(1),
  created_at: isoDateSchema,
  model: z.string().min(1),
});

const taskManifestV1Schema = z.object({
  schema_version: z.literal(1),
  id: idSchema,
  title: z.string().min(1).max(200),
  request: z.string().min(1).max(100_000),
  source_artifact_id: artifactSchema.shape.id,
  references: z.array(taskReferenceSchema).default([]),
  checklist: requirementChecklistSchema.optional(),
  created_at: isoDateSchema,
});

export const preservationContractSchema = z.object({
  color: z.enum(["preserve", "allow_change", "unspecified"]).default("preserve"),
  detail: z.enum(["preserve", "allow_change", "unspecified"]).default("preserve"),
  text: z.enum(["preserve", "allow_change", "unspecified"]).default("preserve"),
  composition: z.enum(["preserve", "allow_change", "unspecified"]).default("preserve"),
  identity: z.enum(["preserve", "allow_change", "unspecified"]).default("preserve"),
  edit_scope: z.enum(["local", "global", "unknown"]).default("unknown"),
  additional_invariants: z.array(z.string().min(1).max(2_000)).max(50).default([]),
});

export const taskManifestV2Schema = z.object({
  schema_version: z.literal(2),
  id: idSchema,
  title: z.string().min(1).max(200),
  user_brief: z.string().min(1).max(100_000),
  source_artifact_id: artifactSchema.shape.id,
  references: z.array(taskReferenceSchema).default([]),
  checklist: requirementChecklistSchema.optional(),
  preservation_contract: preservationContractSchema.default({}),
  has_hidden_evaluation: z.boolean().default(false),
  created_at: isoDateSchema,
});

export const taskManifestSchema = z.union([
  taskManifestV2Schema,
  taskManifestV1Schema.transform((task) => ({
    schema_version: 2 as const,
    id: task.id,
    title: task.title,
    user_brief: task.request,
    source_artifact_id: task.source_artifact_id,
    references: task.references,
    checklist: task.checklist,
    preservation_contract: preservationContractSchema.parse({}),
    has_hidden_evaluation: false,
    created_at: task.created_at,
  })),
]);

export type PreservationContract = z.infer<typeof preservationContractSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type RequirementChecklist = z.infer<typeof requirementChecklistSchema>;

export const runModeSchema = z.enum(["avo", "one_shot", "best_of_n"]);
export type RunMode = z.infer<typeof runModeSchema>;
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "stop_requested",
  "finalization_pending",
  "stopped",
  "completed",
  "budget_exhausted",
  "failed",
  "interrupted",
]);

export const roleProfilesSchema = z.object({
  main: z.enum(["qwen", "78code"]),
  verifier: z.enum(["qwen", "78code"]),
  supervisor: z.enum(["qwen", "78code"]),
});
export type RoleProfiles = z.infer<typeof roleProfilesSchema>;

export const experimentalFeaturesSchema = z.object({
  svg_editing: z.boolean().default(false),
  photo_adjustments: z.boolean().optional(),
  iterative_search: z.boolean().default(false),
  copilot_routing: z.boolean().default(false),
});
export type ExperimentalFeatures = z.infer<typeof experimentalFeaturesSchema>;

export const runConfigSchema = z.object({
  mode: runModeSchema,
  experimental_features: experimentalFeaturesSchema.optional(),
  experiment: z.object({
    suite_id: z.string().min(1),
    arm: z.number().int().min(0).max(4),
    baseline_revision: z.string().min(1),
    implementation_revision: z.string().min(1),
    controls_hash: z.string().min(1),
  }).optional(),
  role_profiles: roleProfilesSchema.optional(),
  supervisor_model: z.string().optional(),
  main_model: z.string().min(1).default("qwen3.8-flash"),
  generator_model: z.string().min(1).default("gpt-image-2"),
  verifier_model: z.string().min(1).default("qwen3.8-flash"),
  max_generations: z.number().int().min(1).max(24).default(24),
  max_wall_time_ms: z.number().int().min(60_000).max(5_400_000).default(5_400_000),
  max_generations_per_round: z.number().int().min(1).max(24).default(24),
  max_variation_steps: z.number().int().min(1).max(100).default(40),
  max_agent_tokens: z.number().int().min(10_000).optional(),
  stop_on_pass: z.boolean().default(false),
  evaluator_revision: z.string().min(1).default("agentic-verifier-v1"),
  supervisor_enabled: z.boolean().default(true),
  provider_revisions: z.object({
    codex: z.string().min(1),
    generator: z.string().min(1),
    verifier: z.string().min(1),
  }).default({
    codex: "unspecified",
    generator: "unspecified",
    verifier: "unspecified",
  }),
});

export type RunConfig = z.infer<typeof runConfigSchema>;

export const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  image_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  estimated_cost_usd: z.number().nonnegative().optional(),
  unpriced: z.boolean().default(true),
});

export type Usage = z.infer<typeof usageSchema>;

export const imageDimensionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const referenceUsageSchema = z.object({
  artifact_id: artifactSchema.shape.id,
  purpose: z.enum(["composition", "color", "texture", "identity", "other"]),
  rationale: z.string().min(1).max(2000),
}).strict();

export const generationInputSchema = z.object({
  base_artifact_id: artifactSchema.shape.id,
  reference_artifact_ids: z.array(artifactSchema.shape.id),
  reference_usage: z.array(referenceUsageSchema).max(24).optional(),
});

export type GenerationInput = z.infer<typeof generationInputSchema>;

export const agentSummarySchema = z.object({
  observation: z.string().min(1),
  hypothesis: z.string().min(1),
  intervention: z.string().min(1),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const candidateDraftSchema = z.object({
  id: idSchema,
  creation_method: z.enum(["image_provider", "svg_edit", "photo_adjustment"]).optional(),
  photo_edit: z.object({
    engine_revision: z.string().min(1),
    recipe_sha256: z.string().min(1),
    base_artifact_id: artifactSchema.shape.id,
    recipe: z.record(z.unknown()),
  }).optional(),
  svg_edit: z.object({
    document_id: z.string().min(1),
    revision: z.number().int().positive(),
    document_sha256: z.string().min(1),
    engine_revision: z.string().min(1),
    source_artifact_ids: z.array(artifactSchema.shape.id),
    operations: z.array(z.string()).max(100),
  }).optional(),
  round: z.number().int().positive(),
  origin_step: z.number().int().positive().optional(),
  status: z.enum([
    "generated",
    "submitted",
    "verifying",
    "verified",
    "rejected_preverify",
    "abandoned",
    "carried_forward",
    "ambiguous",
  ]),
  raw_artifact_id: artifactSchema.shape.id,
  artifact_id: artifactSchema.shape.id,
  parent_artifact_id: artifactSchema.shape.id,
  prompt: z.string().min(1),
  generation_input: generationInputSchema,
  dimensions: z.object({
    source: imageDimensionsSchema,
    provider: imageDimensionsSchema,
    final: imageDimensionsSchema,
    normalized: z.boolean(),
  }),
  viewed_at: isoDateSchema.optional(),
  submitted_at: isoDateSchema.optional(),
  provider_request_id: z.string().min(1).optional(),
  usage: usageSchema.optional(),
  latency_ms: z.number().int().nonnegative(),
  created_at: isoDateSchema,
});

export type CandidateDraft = z.infer<typeof candidateDraftSchema>;

export const requirementVerdictSchema = z.object({
  requirement_id: idSchema,
  verdict: z.enum(["PASS", "FAIL", "UNCLEAR"]),
  score: z.number().min(0).max(100),
  evidence: z.string(),
});

export const verificationResultSchema = z.object({
  status: z.enum(["PASS", "FAIL"]),
  overall_score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  requirements: z.array(requirementVerdictSchema),
  preservation: z.object({
    identity: z.number().min(0).max(100),
    composition: z.number().min(0).max(100),
    unaffected_regions: z.number().min(0).max(100),
  }),
  artifacts: z.array(z.string()),
  feedback: z.array(z.string()),
  model: z.string().min(1),
  usage: usageSchema.optional(),
  latency_ms: z.number().int().nonnegative(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const metricSeveritySchema = z.enum(["ok", "warn", "severe", "unavailable"]);

export const qualityMetricSchema = z.object({
  id: idSchema,
  value: z.number().finite().optional(),
  unit: z.string().min(1).max(64),
  severity: metricSeveritySchema,
  confidence: z.number().min(0).max(1),
  threshold_source: z.enum(["calibrated", "absolute", "heuristic"]),
  detail: z.string().max(2_000).optional(),
});

export const qualityDebtVectorSchema = z.object({
  integrity: z.array(qualityMetricSchema),
  color: z.array(qualityMetricSchema),
  clipping: z.array(qualityMetricSchema),
  detail: z.array(qualityMetricSchema),
  banding: z.array(qualityMetricSchema),
  blockiness: z.array(qualityMetricSchema),
  structure: z.array(qualityMetricSchema),
});

export const parentSelectionSchema = z.object({
  parent_node_id: idSchema,
  artifact_id: artifactSchema.shape.id,
  kind: z.enum(["source", "commit", "draft"]),
  rationale: z.string().min(1).max(10_000),
  override_rationale: z.string().min(1).max(10_000).optional(),
  ancestry_depth: z.number().int().nonnegative(),
  source_debt_severe_count: z.number().int().nonnegative().default(0),
  step_debt_severe_count: z.number().int().nonnegative().default(0),
  selected_at: isoDateSchema,
});

export const promptRevisionSchema = z.object({
  revision: z.number().int().positive(),
  value: z.string().min(1).max(100_000),
  origin: z.enum(["agent", "restored", "legacy"]),
  created_at: isoDateSchema,
});

export const draftEvaluationSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  draft_id: idSchema,
  artifact_id: artifactSchema.shape.id,
  evaluator_revision: z.string().min(1),
  source_quality_debt: qualityDebtVectorSchema,
  step_quality_debt: qualityDebtVectorSchema,
  public_verification: verificationResultSchema,
  hidden_verification: verificationResultSchema.optional(),
  validator_elapsed_ms: z.number().int().nonnegative().optional(),
  agent_feedback: z.array(z.string()).max(100),
  semantic_gain: z.number().min(-100).max(100),
  correctness_gate: z.object({
    passed: z.boolean(),
    blockers: z.array(z.string()).max(100),
    warnings: z.array(z.string()).max(100),
  }),
  comparative_decision_id: idSchema.optional(),
  evaluation_frame_revision_id: idSchema.optional(),
  cache_key: z.string().min(1),
  created_at: isoDateSchema,
});

export const evaluationAxisModeSchema = z.enum(["preserve_source", "match_target", "optimize", "observe"]);
export const evaluationAxisSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(200),
  criterion: z.string().min(1).max(10_000),
  mode: evaluationAxisModeSchema,
  importance: z.enum(["blocker", "major", "minor"]),
  visibility: z.enum(["public", "sealed"]),
  anchor_refs: z.array(z.string().min(1).max(500)).min(1).max(50),
  required_tools: z.array(z.enum([
    "measure_integrity",
    "measure_source_fidelity",
    "measure_parent_delta",
    "measure_target_alignment",
    "measure_artifacts",
    "get_evaluation_history",
  ])).max(10).default([]),
  regions: z.array(z.string().min(1).max(500)).max(50).default([]),
});

export const evaluationFrameRevisionSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  attempt: z.number().int().positive(),
  revision: z.number().int().positive(),
  supersedes_id: idSchema.optional(),
  provenance: z.enum(["verifier", "reused_previous", "deterministic_baseline"]).default("verifier"),
  fallback_reason: z.string().min(1).max(2_000).optional(),
  axes: z.array(evaluationAxisSchema).min(1).max(100),
  target_interpretation: z.object({
    role: z.enum(["none", "directional_reference", "strong_target", "exact_target"]),
    rationale: z.string().min(1).max(10_000),
  }),
  change_summary: z.string().min(1).max(20_000),
  axis_diff: z.object({
    added: z.array(idSchema).max(100),
    removed: z.array(idSchema).max(100),
    changed: z.array(idSchema).max(100),
  }).default({ added: [], removed: [], changed: [] }),
  coverage: z.array(z.object({
    anchor_ref: z.string().min(1).max(500),
    axis_ids: z.array(idSchema).min(1).max(50),
  })).min(1).max(200),
  reconsider_candidate_ids: z.array(idSchema).max(3).default([]),
  model: z.string().min(1),
  created_at: isoDateSchema,
});

export const verifierEvidenceSchema = z.object({
  id: idSchema,
  tool: z.enum([
    "measure_integrity",
    "measure_source_fidelity",
    "measure_parent_delta",
    "measure_target_alignment",
    "measure_artifacts",
    "get_evaluation_history",
  ]),
  summary: z.string().min(1).max(10_000),
  data: z.record(z.unknown()).default({}),
});

export const visualQualityAssessmentSchema = z.object({
  delivery_status: z.enum(["acceptable", "unacceptable", "uncertain"]),
  defects: z.array(z.object({
    region: z.string().min(1).max(500),
    description: z.string().min(1).max(2000),
    origin: z.enum(["source", "inherited", "new", "uncertain"]),
    severity: z.enum(["blocker", "major", "minor"]),
    axis_ids: z.array(idSchema).min(1).max(100),
  })).max(50),
});

export const comparativeVerifierDecisionSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  draft_id: idSchema,
  candidate_artifact_id: artifactSchema.shape.id,
  incumbent_node_id: idSchema,
  incumbent_artifact_id: artifactSchema.shape.id,
  evaluation_frame_revision_id: idSchema,
  correctness: z.enum(["pass", "fail"]),
  incumbent_correctness: z.enum(["pass", "fail", "unclear"]).optional(),
  // Optional only for historical records; new visual reviews require both assessments.
  candidate_quality: visualQualityAssessmentSchema.optional(),
  incumbent_quality: visualQualityAssessmentSchema.optional(),
  technical_gate: z.object({
    passed: z.boolean(),
    blockers: z.array(z.string()).max(100),
    warnings: z.array(z.string()).max(100),
  }),
  preference: z.enum(["better", "equivalent", "worse", "uncertain"]),
  target_progress: z.enum(["improved", "unchanged", "regressed", "not_applicable"]),
  axis_judgments: z.array(z.object({
    axis_id: idSchema,
    verdict: z.enum(["pass", "fail", "unclear"]),
    candidate_score: z.number().min(0).max(100).optional(),
    incumbent_score: z.number().min(0).max(100).optional(),
    evidence: z.string().min(1).max(10_000),
  })).min(1).max(100),
  confidence: z.number().min(0).max(1),
  recommendation: z.enum(["commit", "archive", "adjudicate"]),
  evidence_refs: z.array(idSchema).max(100),
  feedback_for_main_agent: z.array(z.string().min(1).max(10_000)).max(100),
  private_feedback: z.array(z.string().min(1).max(10_000)).max(100).default([]),
  evidence: z.array(verifierEvidenceSchema).max(100).default([]),
  adjudication_of: z.array(idSchema).max(3).default([]),
  cache_key: z.string().min(1),
  model: z.string().min(1),
  usage: usageSchema.optional(),
  latency_ms: z.number().int().nonnegative(),
  created_at: isoDateSchema,
});

export const finalVerifierDecisionSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  evaluation_frame_revision_id: idSchema,
  candidate_node_ids: z.array(idSchema).min(1).max(100),
  selected_node_id: idSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(20_000),
  evidence_refs: z.array(idSchema).max(100).default([]),
  model: z.string().min(1),
  usage: usageSchema.optional(),
  latency_ms: z.number().int().nonnegative(),
  created_at: isoDateSchema,
});

export const lineageReviewSchema = z.object({
  evaluation_frame_revision_id: idSchema,
  correctness: z.enum(["pass", "fail", "unclear"]),
  feedback_for_main_agent: z.array(z.string()).max(50),
  reviewed_at: isoDateSchema,
});

export const lineageNodeSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  kind: z.enum(["seed", "commit"]),
  artifact_id: artifactSchema.shape.id,
  parent_node_id: idSchema.optional(),
  draft_id: idSchema.optional(),
  evaluation_id: idSchema.optional(),
  prompt_revision: z.number().int().positive().optional(),
  ancestry_depth: z.number().int().nonnegative(),
  pareto_active: z.boolean(),
  version: z.number().int().nonnegative().optional(),
  previous_version_node_id: idSchema.optional(),
  derived_from_node_id: idSchema.optional(),
  accepted_evaluation_id: idSchema.optional(),
  evaluation_frame_revision_id: idSchema.optional(),
  committed_at: isoDateSchema,
  current_review: lineageReviewSchema.optional(),
});

export const trialClaimSchema = z.object({
  kind: z.enum(["observational", "clean_source_tested", "clean_source_failed", "base_effect", "reference_effect"]),
  draft_ids: z.array(idSchema).min(1).max(8),
}).strict();

export const hypothesisSchema = z.object({
  id: idSchema,
  statement: z.string().min(1).max(20_000),
  status: z.enum(["proposed", "active", "supported", "refuted", "retired"]),
  evidence_refs: z.array(z.string().min(1).max(200)).max(100),
  trial_claim: trialClaimSchema.optional(),
  alternative_explanations: z.array(z.string().min(1).max(2000)).max(20).optional(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

export const supervisorDecisionSchema = z.object({
  id: idSchema,
  variation_step: z.number().int().positive().optional(),
  intervene: z.boolean(),
  triggers: z.array(z.string()).max(100),
  diagnosis: z.string().min(1),
  branch_strategy: z.enum(["continue", "restart_source", "restore_history", "diversify", "accept_best_and_finish", "stop_search"]),
  recommended_parent_id: idSchema.optional(),
  quality_risks: z.array(z.string()).max(50),
  avoid: z.array(z.string()).max(50),
  try: z.array(z.string()).max(50),
  search_assessment: z.object({
    tested_parent_ids: z.array(z.string().min(1).max(200)).max(100),
    untested_alternatives: z.array(z.string()).max(50),
    conclusion_scope: z.enum(["branch", "tested_alternatives", "search_budget"]),
    strategy_change: z.string(),
    trial_claims: z.array(trialClaimSchema).max(20).optional(),
  }).optional(),
  review_node_ids: z.array(idSchema).max(10).optional(),
  created_at: isoDateSchema,
  consumed_at: isoDateSchema.optional(),
  scope: z.enum(["in_step", "step_boundary"]).optional(),
  trigger_fingerprint: z.string().min(1).optional(),
});

export type QualityMetric = z.infer<typeof qualityMetricSchema>;
export type QualityDebtVector = z.infer<typeof qualityDebtVectorSchema>;
export type ParentSelection = z.infer<typeof parentSelectionSchema>;
export type PromptRevision = z.infer<typeof promptRevisionSchema>;
export type DraftEvaluation = z.infer<typeof draftEvaluationSchema>;
export type EvaluationAxis = z.infer<typeof evaluationAxisSchema>;
export type EvaluationFrameRevision = z.infer<typeof evaluationFrameRevisionSchema>;
export type VerifierEvidence = z.infer<typeof verifierEvidenceSchema>;
export type ComparativeVerifierDecision = z.infer<typeof comparativeVerifierDecisionSchema>;
export type FinalVerifierDecision = z.infer<typeof finalVerifierDecisionSchema>;
export type LineageNode = z.infer<typeof lineageNodeSchema>;
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>;

export const agentStepUsageSchema = z.object({
  total_tokens: z.number().int().nonnegative().default(0),
  tool_calls: z.number().int().nonnegative().default(0),
});

export const variationStepRecordSchema = z.object({
  id: idSchema,
  step: z.number().int().positive(),
  status: z.enum(["running", "submitted", "abandoned", "runtime_cutoff", "failed"]),
  parent_selection: parentSelectionSchema.optional(),
  reference_artifact_ids: z.array(artifactSchema.shape.id).default([]),
  prompt_revision_ids: z.array(idSchema).default([]),
  draft_ids: z.array(idSchema).default([]),
  evaluation_ids: z.array(idSchema).default([]),
  selected_draft_id: idSchema.optional(),
  selected_draft_origin_step: z.number().int().positive().optional(),
  lineage_node_id: idSchema.optional(),
  summary: agentSummarySchema,
  memory_revision_id: idSchema.optional(),
  memory_pending: z.boolean().default(false),
  supervisor_decision_id: idSchema.optional(),
  usage_delta: agentStepUsageSchema.default({}),
  started_at: isoDateSchema,
  finished_at: isoDateSchema.optional(),
  terminal_reason: z.string().max(2_000).optional(),
});

export const variationAttemptRecordSchema = z.object({
  id: idSchema,
  attempt: z.number().int().positive(),
  target_version: z.number().int().positive(),
  status: z.enum(["running", "submitted", "abandoned", "runtime_cutoff", "failed"]),
  evaluation_frame_revision_id: idSchema,
  parent_selection: parentSelectionSchema.optional(),
  reference_artifact_ids: z.array(artifactSchema.shape.id).default([]),
  prompt_revision_ids: z.array(idSchema).default([]),
  draft_ids: z.array(idSchema).default([]),
  evaluation_ids: z.array(idSchema).default([]),
  comparative_decision_ids: z.array(idSchema).default([]),
  selected_draft_id: idSchema.optional(),
  committed_lineage_node_id: idSchema.optional(),
  summary: agentSummarySchema,
  memory_revision_id: idSchema.optional(),
  memory_pending: z.boolean().default(false),
  supervisor_decision_id: idSchema.optional(),
  usage_delta: agentStepUsageSchema.default({}),
  started_at: isoDateSchema,
  finished_at: isoDateSchema.optional(),
  terminal_reason: z.string().max(2_000).optional(),
});

export const searchArchiveEntrySchema = z.object({
  id: idSchema,
  draft_id: idSchema,
  evaluation_id: idSchema,
  comparative_decision_id: idSchema,
  attempt: z.number().int().positive(),
  outcome: z.enum(["equivalent", "worse", "uncertain", "gate_blocked", "not_submitted"]),
  created_at: isoDateSchema,
});

export const supervisorFailureSchema = z.object({
  id: idSchema,
  variation_step: z.number().int().positive(),
  code: z.enum(["timeout", "provider_http_error", "app_server_error", "invalid_structured_output", "unknown_error"]),
  triggers: z.array(z.string()).max(100),
  duration_ms: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  model: z.string().min(1),
  detail: z.string().max(2_000),
  created_at: isoDateSchema,
  scope: z.enum(["in_step", "step_boundary"]).optional(),
  trigger_fingerprint: z.string().min(1).optional(),
});

export type AgentStepUsage = z.infer<typeof agentStepUsageSchema>;
export type VariationStepRecord = z.infer<typeof variationStepRecordSchema>;
export type VariationAttemptRecord = z.infer<typeof variationAttemptRecordSchema>;
export type SearchArchiveEntry = z.infer<typeof searchArchiveEntrySchema>;
export type SupervisorFailure = z.infer<typeof supervisorFailureSchema>;

export const candidateAttemptSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  round: z.number().int().positive(),
  origin_step: z.number().int().positive().optional(),
  decision_step: z.number().int().positive().optional(),
  draft_id: idSchema.optional(),
  parent_attempt_id: idSchema.optional(),
  prompt: z.string().min(1),
  generation_input: generationInputSchema,
  generated_artifact_id: artifactSchema.shape.id,
  generation_usage: usageSchema.optional(),
  agent_summary: agentSummarySchema,
  verification: verificationResultSchema.optional(),
  status: z.enum(["draft", "submitted", "passed", "failed", "verification_error", "ambiguous"]),
  commit_outcome: z.enum(["committed", "gate_blocked", "not_improving", "dominated", "duplicate"]).optional(),
  created_at: isoDateSchema,
});

export type CandidateAttempt = z.infer<typeof candidateAttemptSchema>;

export const workingMemorySchema = z.object({
  useful_findings: z.array(z.string()).max(50).default([]),
  failed_directions: z.array(z.string()).max(50).default([]),
  current_hypotheses: z.array(z.string()).max(25).default([]),
  preservation_constraints: z.array(z.string()).max(25).default([]),
});

export const memoryRevisionSchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  before: workingMemorySchema.optional(),
  after: workingMemorySchema,
  diff: z.record(z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })),
  created_at: isoDateSchema,
});

export const supervisorRedirectSchema = z.object({
  diagnosis: z.string().min(1),
  avoid: z.array(z.string()).max(10),
  try: z.array(z.string()).min(1).max(10),
});

export type WorkingMemory = z.infer<typeof workingMemorySchema>;
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;
export type SupervisorRedirect = z.infer<typeof supervisorRedirectSchema>;

export const stepDeadlineSchema = z.object({
  started_at: isoDateSchema,
  soft_deadline_at: isoDateSchema,
  hard_deadline_at: isoDateSchema,
  state: z.enum(["open", "decision_only", "hard_cutoff"]).default("open"),
});

export const pendingDecisionSchema = z.object({
  source_step: z.number().int().positive(),
  draft_ids: z.array(idSchema),
  evaluation_ids: z.array(idSchema),
  reason: z.string().min(1).max(2_000),
  created_at: isoDateSchema,
});

export const pendingFinalizationSchema = z.object({
  requested_status: z.enum(["completed", "budget_exhausted"]),
  terminal_reason: z.string().min(1).max(2_000),
  supervisor_decision_id: idSchema.optional(),
  failure_code: z.enum(["invalid_structured_output", "timeout", "provider_http_error", "app_server_error", "unknown_error"]),
  last_error: z.string().min(1).max(20_000),
  attempts: z.number().int().positive(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

export type StepDeadline = z.infer<typeof stepDeadlineSchema>;
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;
export type PendingFinalization = z.infer<typeof pendingFinalizationSchema>;

const runSnapshotV2Schema = z.object({
  schema_version: z.literal(2),
  id: idSchema,
  task_id: idSchema,
  config: runConfigSchema,
  status: runStatusSchema,
  prompt: z.string(),
  current_prompt: z.string(),
  selected_input: generationInputSchema.optional(),
  selected_generation_input: generationInputSchema.optional(),
  active_round: z.number().int().positive(),
  drafts: z.array(candidateDraftSchema),
  submitted_draft_id: idSchema.optional(),
  recovery_source: z.enum(["legacy_events"]).optional(),
  recovered_at: isoDateSchema.optional(),
  recovery_warnings: z.array(z.string()).default([]),
  attempts: z.array(candidateAttemptSchema),
  lineage_attempt_ids: z.array(idSchema),
  best_failed_attempt_id: idSchema.optional(),
  working_memory: workingMemorySchema,
  pending_supervisor_redirect: supervisorRedirectSchema.optional(),
  consecutive_failures: z.number().int().nonnegative(),
  generation_count: z.number().int().nonnegative(),
  verifier_count: z.number().int().nonnegative(),
  started_at: isoDateSchema.optional(),
  finished_at: isoDateSchema.optional(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  terminal_reason: z.string().optional(),
});

export const runSnapshotV3Schema = z.object({
  schema_version: z.literal(3),
  id: idSchema,
  task_id: idSchema,
  config: runConfigSchema,
  status: runStatusSchema,
  prompt: z.string().default(""),
  current_prompt: z.string().default(""),
  generation_prompt: promptRevisionSchema.optional(),
  prompt_revisions: z.array(promptRevisionSchema).default([]),
  selected_input: generationInputSchema.optional(),
  selected_generation_input: generationInputSchema.optional(),
  parent_selection: parentSelectionSchema.optional(),
  selected_reference_artifact_ids: z.array(artifactSchema.shape.id).default([]),
  active_round: z.number().int().positive(),
  active_variation_step: z.number().int().positive().default(1),
  drafts: z.array(candidateDraftSchema),
  evaluations: z.array(draftEvaluationSchema).default([]),
  submitted_draft_id: idSchema.optional(),
  submitted_evaluation_id: idSchema.optional(),
  recovery_source: z.enum(["legacy_events"]).optional(),
  recovered_at: isoDateSchema.optional(),
  recovery_warnings: z.array(z.string()).default([]),
  attempts: z.array(candidateAttemptSchema),
  lineage_attempt_ids: z.array(idSchema),
  lineage_nodes: z.array(lineageNodeSchema).default([]),
  pareto_node_ids: z.array(idSchema).default([]),
  final_lineage_node_id: idSchema.optional(),
  terminal_supervisor_decision_id: idSchema.optional(),
  best_failed_attempt_id: idSchema.optional(),
  working_memory: workingMemorySchema,
  memory_revisions: z.array(memoryRevisionSchema).default([]),
  hypotheses: z.array(hypothesisSchema).default([]),
  pending_supervisor_redirect: supervisorRedirectSchema.optional(),
  pending_supervisor_decision: supervisorDecisionSchema.optional(),
  deferred_supervisor_triggers: z.array(z.string()).default([]),
  supervisor_decisions: z.array(supervisorDecisionSchema).default([]),
  supervisor_failures: z.array(supervisorFailureSchema).default([]),
  variation_steps: z.array(variationStepRecordSchema).default([]),
  pending_decision: pendingDecisionSchema.optional(),
  pending_finalization: pendingFinalizationSchema.optional(),
  step_deadline: stepDeadlineSchema.optional(),
  decision_policy_revision: z.string().min(1).default("image-avo-v2"),
  mixed_policy_revision: z.boolean().default(false),
  memory_pending: z.boolean().default(false),
  validator_trends: z.array(z.object({
    evaluation_id: idSchema,
    draft_id: idSchema,
    semantic_gain: z.number(),
    source_severe: z.number().int().nonnegative(),
    source_warn: z.number().int().nonnegative(),
    step_severe: z.number().int().nonnegative(),
    step_warn: z.number().int().nonnegative(),
    at: isoDateSchema,
  })).default([]),
  consecutive_failures: z.number().int().nonnegative(),
  generation_count: z.number().int().nonnegative(),
  verifier_count: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative().default(0),
  agent_total_tokens: z.number().int().nonnegative().default(0),
  agent_thread_id: z.string().min(1).optional(),
  context_compactions: z.number().int().nonnegative().default(0),
  legacy_read_only: z.boolean().default(false),
  started_at: isoDateSchema.optional(),
  finished_at: isoDateSchema.optional(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  terminal_reason: z.string().optional(),
});

export const runSnapshotV4Schema = runSnapshotV3Schema.omit({ schema_version: true }).extend({
  experimental_state: z.record(z.unknown()).optional(),
  schema_version: z.literal(4),
  human_intent_revision: z.string().min(1),
  active_evolution_version: z.number().int().nonnegative().default(0),
  active_variation_attempt: z.number().int().positive().default(1),
  evaluation_frame_revisions: z.array(evaluationFrameRevisionSchema).default([]),
  variation_attempts: z.array(variationAttemptRecordSchema).default([]),
  comparative_decisions: z.array(comparativeVerifierDecisionSchema).default([]),
  search_archive: z.array(searchArchiveEntrySchema).default([]),
  incumbent_node_id: idSchema,
  final_verifier_decisions: z.array(finalVerifierDecisionSchema).default([]),
  final_verifier_decision_id: idSchema.optional(),
});

const runSnapshotV1Schema = z.object({
  schema_version: z.literal(1),
  id: idSchema,
  task_id: idSchema,
  config: runConfigSchema,
  status: runStatusSchema,
  prompt: z.string(),
  selected_input: generationInputSchema.optional(),
  attempts: z.array(candidateAttemptSchema),
  lineage_attempt_ids: z.array(idSchema),
  best_failed_attempt_id: idSchema.optional(),
  working_memory: workingMemorySchema,
  pending_supervisor_redirect: supervisorRedirectSchema.optional(),
  consecutive_failures: z.number().int().nonnegative(),
  generation_count: z.number().int().nonnegative(),
  verifier_count: z.number().int().nonnegative(),
  started_at: isoDateSchema.optional(),
  finished_at: isoDateSchema.optional(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  terminal_reason: z.string().optional(),
});

type RunSnapshotV2 = z.infer<typeof runSnapshotV2Schema>;
type RunSnapshotV3 = z.infer<typeof runSnapshotV3Schema>;
export type RunSnapshotV4 = z.infer<typeof runSnapshotV4Schema>;

const upgradeV2Run = (run: RunSnapshotV2): RunSnapshotV3 => runSnapshotV3Schema.parse({
  ...run,
  schema_version: 3 as const,
  generation_prompt: run.current_prompt
    ? { revision: 1, value: run.current_prompt, origin: "legacy" as const, created_at: run.created_at }
    : undefined,
  prompt_revisions: run.current_prompt
    ? [{ revision: 1, value: run.current_prompt, origin: "legacy" as const, created_at: run.created_at }]
    : [],
  parent_selection: undefined,
  selected_reference_artifact_ids: run.selected_generation_input?.reference_artifact_ids ?? [],
  active_variation_step: run.active_round,
  evaluations: [],
  submitted_evaluation_id: undefined,
  lineage_nodes: [],
  pareto_node_ids: [],
  memory_revisions: [],
  hypotheses: [],
  pending_supervisor_decision: undefined,
  supervisor_decisions: [],
  supervisor_failures: [],
  variation_steps: [],
  memory_pending: false,
  validator_trends: [],
  tool_call_count: 0,
  agent_total_tokens: 0,
  agent_thread_id: undefined,
  context_compactions: 0,
  legacy_read_only: true,
});

const runSnapshotV1UpgradedSchema = runSnapshotV1Schema.transform((run) => upgradeV2Run({
  ...run,
  schema_version: 2 as const,
  current_prompt: run.prompt,
  selected_generation_input: run.selected_input,
  active_round: Math.max(1, run.attempts.length + 1),
  drafts: [],
  submitted_draft_id: undefined,
  recovery_source: undefined,
  recovered_at: undefined,
  recovery_warnings: [],
}));

const upgradeV3Run = (run: RunSnapshotV3): RunSnapshotV4 => {
  const persistedSeed = run.lineage_nodes.find((node) => node.kind === "seed");
  const seedArtifactId = persistedSeed?.artifact_id
    ?? run.selected_generation_input?.base_artifact_id
    ?? run.selected_input?.base_artifact_id
    ?? run.drafts[0]?.generation_input.base_artifact_id
    ?? run.drafts[0]?.parent_artifact_id
    ?? run.attempts[0]?.generation_input.base_artifact_id
    ?? run.lineage_nodes[0]?.artifact_id
    ?? run.attempts[0]?.generated_artifact_id;
  if (!seedArtifactId) throw new Error("legacy_run_missing_source_artifact");
  const seed = persistedSeed
    ? { ...persistedSeed, version: 0 as const, pareto_active: false }
    : {
        id: `node-legacy-seed-${run.id}`,
        run_id: run.id,
        kind: "seed" as const,
        artifact_id: seedArtifactId,
        ancestry_depth: 0,
        pareto_active: false,
        version: 0 as const,
        committed_at: run.created_at,
      };
  type LegacyProjectedCommit = z.infer<typeof lineageNodeSchema> & { generation_base_artifact_id?: string };
  const persistedCommits: LegacyProjectedCommit[] = run.lineage_nodes
    .filter((node) => node.kind === "commit")
    .map((node) => ({ ...node, kind: "commit" as const }));
  const projectedAttempts: LegacyProjectedCommit[] = persistedCommits.length === 0
    ? run.attempts.filter((attempt) => run.lineage_attempt_ids.includes(attempt.id)).map((attempt) => ({
        id: `node-legacy-${attempt.id}`,
        run_id: run.id,
        kind: "commit" as const,
        artifact_id: attempt.generated_artifact_id,
        ...(attempt.draft_id ? { draft_id: attempt.draft_id } : {}),
        prompt_revision: attempt.round,
        ancestry_depth: attempt.round,
        pareto_active: false,
        committed_at: attempt.created_at,
        generation_base_artifact_id: attempt.generation_input.base_artifact_id,
      }))
    : [];
  const rawCommits = persistedCommits.length > 0 ? persistedCommits : projectedAttempts;
  const officialNodes: Array<z.infer<typeof lineageNodeSchema>> = [seed];
  for (const [index, rawNode] of rawCommits.entries()) {
    const generationBaseArtifactId = "generation_base_artifact_id" in rawNode
      ? rawNode.generation_base_artifact_id
      : run.drafts.find((draft) => draft.id === rawNode.draft_id)?.generation_input.base_artifact_id;
    const derivedFrom = officialNodes.findLast((node) => node.artifact_id === generationBaseArtifactId)
      ?? officialNodes.find((node) => node.id === rawNode.parent_node_id)
      ?? officialNodes.at(-1)!;
    const { generation_base_artifact_id: _generationBaseArtifactId, ...node } = rawNode;
    const previous = officialNodes.at(-1)!;
    officialNodes.push({
      ...node,
      version: index + 1,
      previous_version_node_id: previous.id,
      derived_from_node_id: rawNode.derived_from_node_id ?? derivedFrom.id,
      parent_node_id: rawNode.parent_node_id ?? derivedFrom.id,
      pareto_active: false,
    });
  }
  const commits = officialNodes.filter((node) => node.kind === "commit");
  const incumbent = officialNodes.find((node) => node.id === run.final_lineage_node_id) ?? commits.at(-1) ?? seed;
  let acceptedVersion = 0;
  const attemptsFromSteps = run.variation_steps.map((step) => {
    const committedNode = step.lineage_node_id
      ? officialNodes.find((node) => node.id === step.lineage_node_id && node.kind === "commit")
      : undefined;
    const targetVersion = acceptedVersion + 1;
    if (committedNode) acceptedVersion = committedNode.version ?? targetVersion;
    return {
      id: `variation-attempt-legacy-${run.id}-${step.step}`,
      attempt: step.step,
      target_version: targetVersion,
      status: step.status,
      evaluation_frame_revision_id: `frame-legacy-readonly-${run.id}-${step.step}`,
      parent_selection: step.parent_selection,
      reference_artifact_ids: step.reference_artifact_ids,
      prompt_revision_ids: step.prompt_revision_ids,
      draft_ids: step.draft_ids,
      evaluation_ids: step.evaluation_ids,
      comparative_decision_ids: [],
      selected_draft_id: step.selected_draft_id,
      committed_lineage_node_id: committedNode?.id,
      summary: step.summary,
      memory_revision_id: step.memory_revision_id,
      memory_pending: step.memory_pending,
      supervisor_decision_id: step.supervisor_decision_id,
      usage_delta: step.usage_delta,
      started_at: step.started_at,
      finished_at: step.finished_at,
      terminal_reason: step.terminal_reason,
    };
  });
  const variationAttempts = attemptsFromSteps.length > 0 ? attemptsFromSteps : run.attempts.map((attempt, index) => {
    const committedNode = officialNodes.find((node) => node.kind === "commit" && node.artifact_id === attempt.generated_artifact_id);
    const parentNode = officialNodes.find((node) => node.artifact_id === attempt.generation_input.base_artifact_id) ?? seed;
    const evaluation = run.evaluations.find((item) => item.artifact_id === attempt.generated_artifact_id);
    const targetVersion = acceptedVersion + 1;
    if (committedNode) acceptedVersion = committedNode.version ?? targetVersion;
    return {
      id: `variation-attempt-legacy-${run.id}-${index + 1}`,
      attempt: index + 1,
      target_version: targetVersion,
      status: committedNode ? "submitted" as const : attempt.status === "ambiguous" ? "failed" as const : "abandoned" as const,
      evaluation_frame_revision_id: `frame-legacy-readonly-${run.id}-${index + 1}`,
      parent_selection: {
        parent_node_id: parentNode.id,
        artifact_id: attempt.generation_input.base_artifact_id,
        kind: parentNode.kind === "seed" ? "source" as const : "commit" as const,
        rationale: "Read-only projection of the parent recorded by the legacy run.",
        ancestry_depth: parentNode.ancestry_depth,
        source_debt_severe_count: 0,
        step_debt_severe_count: 0,
        selected_at: attempt.created_at,
      },
      reference_artifact_ids: attempt.generation_input.reference_artifact_ids,
      prompt_revision_ids: [],
      draft_ids: attempt.draft_id ? [attempt.draft_id] : [],
      evaluation_ids: evaluation ? [evaluation.id] : [],
      comparative_decision_ids: [],
      selected_draft_id: attempt.draft_id,
      committed_lineage_node_id: committedNode?.id,
      summary: attempt.agent_summary,
      memory_pending: false,
      usage_delta: { total_tokens: attempt.generation_usage?.total_tokens ?? 0, tool_calls: 0 },
      started_at: attempt.created_at,
      finished_at: attempt.created_at,
      terminal_reason: committedNode ? undefined : `legacy_${attempt.status}`,
    };
  });
  return runSnapshotV4Schema.parse({
    ...run,
    schema_version: 4 as const,
    human_intent_revision: `legacy-${run.task_id}`,
    active_evolution_version: commits.length,
    active_variation_attempt: Math.max(1, run.active_variation_step),
    lineage_nodes: officialNodes,
    pareto_node_ids: [],
    evaluation_frame_revisions: [],
    variation_attempts: variationAttempts,
    comparative_decisions: [],
    search_archive: [],
    incumbent_node_id: incumbent.id,
    final_verifier_decisions: [],
    final_verifier_decision_id: undefined,
    legacy_read_only: true,
  });
};

export const runSnapshotSchema = z.union([
  runSnapshotV4Schema,
  runSnapshotV3Schema.transform(upgradeV3Run),
  runSnapshotV2Schema.transform((run) => upgradeV3Run(upgradeV2Run(run))),
  runSnapshotV1UpgradedSchema.transform(upgradeV3Run),
]);

export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const runEventSchema = z.object({
  sequence: z.number().int().positive(),
  run_id: idSchema,
  type: z.string().min(1),
  at: isoDateSchema,
  data: z.record(z.unknown()),
});

export type RunEvent = z.infer<typeof runEventSchema>;

export const providerHealthSchema = z.object({
  codex: z.object({ enabled: z.boolean(), ok: z.boolean(), message: z.string() }),
  generator: z.object({ enabled: z.boolean(), ok: z.boolean(), message: z.string() }),
  verifier: z.object({ enabled: z.boolean(), ok: z.boolean(), message: z.string() }),
  runnable: z.boolean(),
});

export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const benchmarkConclusionSchema = z.object({
  verdict: z.enum(["avo_better", "inconclusive", "not_better"]),
  notes: z.string().max(20_000).default(""),
  recorded_at: isoDateSchema,
});

export const benchmarkSnapshotSchema = z.object({
  schema_version: z.literal(1),
  id: idSchema,
  task_ids: z.array(idSchema).min(1).max(10),
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  schedule: z.array(z.object({ task_id: idSchema, mode: runModeSchema })),
  run_ids: z.array(idSchema),
  conclusion: benchmarkConclusionSchema.optional(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

export type BenchmarkSnapshot = z.infer<typeof benchmarkSnapshotSchema>;
