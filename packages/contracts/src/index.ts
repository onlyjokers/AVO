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

export const taskManifestSchema = z.object({
  schema_version: z.literal(1),
  id: idSchema,
  title: z.string().min(1).max(200),
  request: z.string().min(1).max(100_000),
  source_artifact_id: artifactSchema.shape.id,
  references: z.array(taskReferenceSchema).default([]),
  checklist: requirementChecklistSchema.optional(),
  created_at: isoDateSchema,
});

export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type RequirementChecklist = z.infer<typeof requirementChecklistSchema>;

export const runModeSchema = z.enum(["avo", "one_shot", "best_of_n"]);
export type RunMode = z.infer<typeof runModeSchema>;
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "stop_requested",
  "stopped",
  "completed",
  "budget_exhausted",
  "failed",
  "interrupted",
]);

export const runConfigSchema = z.object({
  mode: runModeSchema,
  main_model: z.string().min(1).default("qwen3.8-flash"),
  generator_model: z.string().min(1).default("gpt-image-2"),
  verifier_model: z.string().min(1).default("qwen3.8-flash"),
  max_generations: z.number().int().min(1).max(24).default(24),
  max_wall_time_ms: z.number().int().min(60_000).max(5_400_000).default(5_400_000),
  max_generations_per_round: z.number().int().min(1).max(2).default(2),
  stop_on_pass: z.literal(true).default(true),
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

export const generationInputSchema = z.object({
  base_artifact_id: artifactSchema.shape.id,
  reference_artifact_ids: z.array(artifactSchema.shape.id),
});

export type GenerationInput = z.infer<typeof generationInputSchema>;

export const agentSummarySchema = z.object({
  observation: z.string().min(1),
  hypothesis: z.string().min(1),
  intervention: z.string().min(1),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

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

export const candidateAttemptSchema = z.object({
  id: idSchema,
  run_id: idSchema,
  round: z.number().int().positive(),
  parent_attempt_id: idSchema.optional(),
  prompt: z.string().min(1),
  generation_input: generationInputSchema,
  generated_artifact_id: artifactSchema.shape.id,
  generation_usage: usageSchema.optional(),
  agent_summary: agentSummarySchema,
  verification: verificationResultSchema.optional(),
  status: z.enum(["draft", "submitted", "passed", "failed", "verification_error", "ambiguous"]),
  created_at: isoDateSchema,
});

export type CandidateAttempt = z.infer<typeof candidateAttemptSchema>;

export const workingMemorySchema = z.object({
  useful_findings: z.array(z.string()).max(50).default([]),
  failed_directions: z.array(z.string()).max(50).default([]),
  current_hypotheses: z.array(z.string()).max(25).default([]),
  preservation_constraints: z.array(z.string()).max(25).default([]),
});

export const supervisorRedirectSchema = z.object({
  diagnosis: z.string().min(1),
  avoid: z.array(z.string()).max(10),
  try: z.array(z.string()).min(1).max(10),
});

export type WorkingMemory = z.infer<typeof workingMemorySchema>;
export type SupervisorRedirect = z.infer<typeof supervisorRedirectSchema>;

export const runSnapshotSchema = z.object({
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
