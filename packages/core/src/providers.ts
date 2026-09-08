import type {
  AgentSummary,
  CandidateDraft,
  CandidateAttempt,
  ComparativeVerifierDecision,
  DraftEvaluation,
  EvaluationFrameRevision,
  FinalVerifierDecision,
  GenerationInput,
  Hypothesis,
  LineageNode,
  ParentSelection,
  RequirementChecklist,
  RunSnapshot,
  StepDeadline,
  SupervisorRedirect,
  SupervisorDecision,
  TaskManifest,
  Usage,
  VerificationResult,
  WorkingMemory,
} from "@avo/contracts";

export type ImageGenerationResult = {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  originalName: string;
  usage?: Usage;
  latencyMs: number;
  providerRequestId?: string;
  providerAttempts?: Array<{
    attempt: number;
    requestId?: string;
    status: "timed_out" | "failed" | "succeeded";
    latencyMs: number;
    error?: string;
  }>;
};

export type AgentRoundContext = {
  task: TaskManifest;
  checklist: RequirementChecklist;
  run: RunSnapshot;
  imagePool: ImagePoolItem[];
  recentAttempts: CandidateAttempt[];
  supervisorRedirect?: SupervisorRedirect;
  supervisorDecision?: SupervisorDecision;
};

export type ImagePoolItem = {
  artifactId: string;
  path: string;
  caption?: string;
  kind: "source" | "reference" | "candidate" | "draft";
  draft?: CandidateDraft;
};

export type AgentSubmission = {
  draftId: string;
  artifactId: string;
  evaluationId: string;
  decisionId: string;
  summary: AgentSummary;
  memoryUpdate?: WorkingMemory;
  decisionStep: number;
};

export type AgentStepAbandonment = {
  reason: string;
  summary: AgentSummary;
  status: "abandoned" | "runtime_cutoff" | "failed";
  memoryUpdate?: WorkingMemory;
};

export type BestOfVariant = {
  prompt: string;
  input: GenerationInput;
  summary: AgentSummary;
};

export type SupervisorAdvice = {
  intervene: boolean;
  diagnosis: string;
  branch_strategy: "continue" | "restart_source" | "restore_history" | "diversify" | "stop_search";
  recommended_parent_id?: string;
  quality_risks: string[];
  avoid: string[];
  try: string[];
  search_assessment?: {
    tested_parent_ids: string[];
    untested_alternatives: string[];
    conclusion_scope: "branch" | "tested_alternatives" | "search_budget";
    strategy_change: string;
    trial_claims?: NonNullable<RunSnapshot["hypotheses"][number]["trial_claim"]>[] | undefined;
  };
  review_node_ids?: string[];
};

export type SupervisorRequest = {
  triggers: string[];
  scope: "in_step" | "step_boundary";
};

export interface AgentToolbox {
  getRunSnapshot(): RunSnapshot;
  getLineage(): LineageNode[];
  getMemory(): { current: WorkingMemory; revisions: RunSnapshot["memory_revisions"]; hypotheses: Hypothesis[] };
  getEvaluation(evaluationId: string): DraftEvaluation;
  getPrompt(): string;
  setPrompt(prompt: string): Promise<void>;
  appendPrompt(fragment: string): Promise<void>;
  replacePrompt(oldText: string, newText: string): Promise<void>;
  deletePromptFragment(fragment: string): Promise<void>;
  selectParent(parentNodeId: string, rationale: string, overrideRationale?: string): Promise<ParentSelection>;
  selectReferences(artifactIds: string[], usage?: GenerationInput["reference_usage"]): Promise<void>;
  selectGenerationInputs(input: GenerationInput): Promise<void>;
  listImagePool(): Promise<ImagePoolItem[]>;
  viewImage(artifactId: string): Promise<{ path: string; mimeType: string }>;
  generateImage(): Promise<string>;
  recordEditedDraft(input: {
    bytes: Buffer;
    description: string;
    parentArtifactId: string;
    latencyMs: number;
  } & ({ edit: NonNullable<CandidateDraft["svg_edit"]>; photoEdit?: never }
    | { photoEdit: NonNullable<CandidateDraft["photo_edit"]>; edit?: never })): Promise<string>;
  recordExperimentState(kind: "iterative" | "copilot", state: unknown, detail?: Record<string, unknown>): Promise<void>;
  evaluateDraft(draftId: string): Promise<DraftEvaluation>;
  declinePendingDecision(rationale: string): Promise<void>;
  restoreAttempt(attemptId: string): Promise<void>;
  updateWorkingMemory(memory: WorkingMemory): Promise<void>;
  upsertHypothesis(hypothesis: Omit<Hypothesis, "created_at" | "updated_at">): Promise<Hypothesis>;
  submitCandidate(draftId: string, decisionId: string, summary: AgentSummary, memoryUpdate?: WorkingMemory): Promise<{ draftId: string; artifactId: string; evaluationId: string; decisionId: string }>;
  abandonStep(reason: string, summary: AgentSummary, memoryUpdate?: WorkingMemory, status?: "abandoned" | "runtime_cutoff" | "failed"): Promise<void>;
  recordAgentRuntime(usage: { totalTokens?: number; toolCalls?: number }): Promise<void>;
  recordContextCompaction(): Promise<void>;
  setStepDeadline(deadline: StepDeadline): Promise<void>;
  waitForSubmission(): Promise<AgentSubmission>;
  waitForAbandonment(): Promise<AgentStepAbandonment>;
  signalBudgetExceeded(reason: string): void;
  waitForBudgetExceeded(): Promise<string>;
  signalStop(): void;
  waitForStop(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  runRound(context: AgentRoundContext, tools: AgentToolbox): Promise<void>;
  planBestOf(context: AgentRoundContext, count: number): Promise<BestOfVariant[]>;
  supervise(context: AgentRoundContext, request: SupervisorRequest): Promise<SupervisorAdvice>;
  closeRun?(runId: string): Promise<void>;
}

export interface ImageProvider {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  generate(input: {
    prompt: string;
    base: { path: string; mimeType: string };
    references: Array<{ path: string; mimeType: string }>;
    idempotencyKey: string;
  }): Promise<ImageGenerationResult>;
}

export interface VerifierProvider {
  readonly id: string;
  reviewLineage?(input: {
    runId: string;
    task: TaskManifest;
    frame: EvaluationFrameRevision;
    sourcePath: string;
    node: LineageNode;
    nodePath: string;
    earlierImages: Array<{ node: LineageNode; path: string }>;
    references: Array<{ path: string; caption?: string }>;
    hiddenTargetPath?: string;
    privateInstructions?: string;
  }): Promise<NonNullable<LineageNode["current_review"]>>;
  probe(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  createChecklist(input: {
    task: TaskManifest;
    sourcePath: string;
    references: Array<{ path: string; caption?: string }>;
  }): Promise<RequirementChecklist>;
  verify(input: {
    runId: string;
    attemptNumber: number;
    task: TaskManifest;
    checklist: RequirementChecklist;
    sourcePath: string;
    references: Array<{ path: string; caption?: string }>;
    candidatePath: string;
    scope?: "public" | "sealed";
    hiddenTargetPath?: string;
    privateRubric?: string;
  }): Promise<VerificationResult>;
  createEvaluationFrame(input: {
    runId: string;
    attempt: number;
    task: TaskManifest;
    sourcePath: string;
    publicReferences: Array<{ path: string; caption?: string }>;
    sealedReferences: Array<{ path: string; caption?: string }>;
    hiddenTargetPath?: string;
    privateInstructions?: string;
    previousFrame?: EvaluationFrameRevision;
    lineage: LineageNode[];
    archive: RunSnapshot["search_archive"];
    recentAttempts: RunSnapshot["variation_attempts"];
  }): Promise<EvaluationFrameRevision>;
  compare(input: {
    runId: string;
    draftId: string;
    candidateArtifactId: string;
    task: TaskManifest;
    frame: EvaluationFrameRevision;
    sourcePath: string;
    parentPath: string;
    incumbentNode: LineageNode;
    incumbentPath: string;
    candidatePath: string;
    publicReferences: Array<{ path: string; caption?: string }>;
    sealedReferences: Array<{ path: string; caption?: string }>;
    hiddenTargetPath?: string;
    privateInstructions?: string;
    history: ComparativeVerifierDecision[];
    technicalGate: ComparativeVerifierDecision["technical_gate"];
    callTool: (tool: VerifierToolName) => Promise<VerifierEvidence>;
  }): Promise<ComparativeVerifierDecision>;
  selectFinal(input: {
    runId: string;
    task: TaskManifest;
    frame: EvaluationFrameRevision;
    sourcePath: string;
    candidates: Array<{
      node: LineageNode;
      path: string;
      origin?: "lineage" | "archive";
      acceptedDecision?: ComparativeVerifierDecision;
    }>;
    publicReferences: Array<{ path: string; caption?: string }>;
    sealedReferences: Array<{ path: string; caption?: string }>;
    hiddenTargetPath?: string;
    privateInstructions?: string;
  }): Promise<FinalVerifierDecision>;
}

export type VerifierToolName = ComparativeVerifierDecision["evidence"][number]["tool"];
export type VerifierEvidence = ComparativeVerifierDecision["evidence"][number];
