import type {
  AgentSummary,
  CandidateAttempt,
  GenerationInput,
  RequirementChecklist,
  RunSnapshot,
  SupervisorRedirect,
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
};

export type AgentRoundContext = {
  task: TaskManifest;
  checklist: RequirementChecklist;
  run: RunSnapshot;
  imagePool: Array<{ artifactId: string; path: string; caption?: string; kind: "source" | "reference" | "candidate" }>;
  recentAttempts: CandidateAttempt[];
  supervisorRedirect?: SupervisorRedirect;
};

export type BestOfVariant = {
  prompt: string;
  input: GenerationInput;
  summary: AgentSummary;
};

export interface AgentToolbox {
  getRunSnapshot(): RunSnapshot;
  getPrompt(): string;
  setPrompt(prompt: string): void;
  appendPrompt(fragment: string): void;
  replacePrompt(oldText: string, newText: string): void;
  deletePromptFragment(fragment: string): void;
  selectGenerationInputs(input: GenerationInput): void;
  generateImage(): Promise<string>;
  restoreAttempt(attemptId: string): Promise<void>;
  updateWorkingMemory(memory: WorkingMemory): Promise<void>;
  submitCandidate(artifactId: string, summary: AgentSummary): void;
}

export interface AgentProvider {
  readonly id: string;
  probe(): Promise<{ ok: boolean; message: string }>;
  runRound(context: AgentRoundContext, tools: AgentToolbox): Promise<void>;
  planBestOf(context: AgentRoundContext, count: number): Promise<BestOfVariant[]>;
  supervise(context: AgentRoundContext): Promise<SupervisorRedirect>;
}

export interface ImageProvider {
  readonly id: string;
  probe(): Promise<{ ok: boolean; message: string }>;
  generate(input: {
    prompt: string;
    base: { path: string; mimeType: string };
    references: Array<{ path: string; mimeType: string }>;
    idempotencyKey: string;
  }): Promise<ImageGenerationResult>;
}

export interface VerifierProvider {
  readonly id: string;
  probe(): Promise<{ ok: boolean; message: string }>;
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
  }): Promise<VerificationResult>;
}
