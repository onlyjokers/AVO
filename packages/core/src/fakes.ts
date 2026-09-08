import { readFile } from "node:fs/promises";
import type { ComparativeVerifierDecision, EvaluationFrameRevision, FinalVerifierDecision } from "@avo/contracts";
import type { AgentProvider, AgentRoundContext, AgentToolbox, ImageProvider, SupervisorAdvice, SupervisorRequest, VerifierProvider } from "./providers.ts";

export class FakeAgentProvider implements AgentProvider {
  readonly id = "fake-agent";

  async probe() { return { ok: true, message: "Fake Codex ready" }; }

  async runRound(context: AgentRoundContext, tools: AgentToolbox) {
    const round = context.run.attempts.length + 1;
    await tools.setPrompt(`${context.task.user_brief}\n\nIteration ${round}: preserve the source composition and satisfy every requirement.`);
    const sourceNode = context.run.lineage_nodes.find((node) => node.kind === "seed")!;
    await tools.selectParent(sourceNode.id, "Use the source as the lowest-debt parent for the deterministic fake run.");
    await tools.selectReferences(context.task.references.map((reference) => reference.artifact_id));
    const artifactId = await tools.generateImage();
    await tools.viewImage(artifactId);
    const draft = tools.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId)!;
    const evaluation = await tools.evaluateDraft(draft.id);
    if (!evaluation.comparative_decision_id) throw new Error("fake_comparative_decision_missing");
    const summary = {
      observation: round === 1 ? "No prior candidate exists." : "The previous candidate still missed requirements.",
      hypothesis: "A focused preservation instruction should improve the next result.",
      intervention: `Generated deterministic fake candidate ${round}.`,
    };
    const memory = {
      useful_findings: [`Variation ${round} was viewed and evaluated before submission.`],
      failed_directions: evaluation.public_verification.status === "FAIL" ? [`Variation ${round} did not satisfy every requirement.`] : [],
      current_hypotheses: ["Focused preservation instructions reduce avoidable source drift."],
      preservation_constraints: ["Preserve source composition and protected task invariants."],
    };
    const decision = tools.getRunSnapshot().comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id);
    if (decision?.recommendation === "commit") await tools.submitCandidate(draft.id, decision.id, summary, memory);
    else await tools.abandonStep("fake_verifier_did_not_recommend_commit", summary, memory);
  }

  async planBestOf(context: AgentRoundContext, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      prompt: `${context.task.user_brief}\n\nIndependent no-feedback variant ${index + 1}.`,
      input: {
        base_artifact_id: context.task.source_artifact_id,
        reference_artifact_ids: context.task.references.map((reference) => reference.artifact_id),
      },
      summary: {
        observation: "Planned without generation or verifier feedback.",
        hypothesis: `Independent variant ${index + 1} may satisfy the request.`,
        intervention: `Generated baseline variant ${index + 1}.`,
      },
    }));
  }

  async supervise(_context: AgentRoundContext, _request: SupervisorRequest): Promise<SupervisorAdvice> {
    return {
      intervene: true,
      diagnosis: "Three candidates failed without resolving the primary requirement.",
      branch_strategy: "diversify" as const,
      quality_risks: [],
      avoid: ["Repeating the same broad prompt"],
      try: ["Change one constraint at a time", "Restore the highest-scoring failed candidate"],
    };
  }
}

export class FakeImageProvider implements ImageProvider {
  readonly id = "fake-image";
  async probe() { return { ok: true, message: "Fake GPT Image 2 ready" }; }
  async generate(input: Parameters<ImageProvider["generate"]>[0]) {
    const started = Date.now();
    const source = await readFile(input.base.path);
    return {
      bytes: Buffer.concat([source, Buffer.from(`\nAVO_FAKE:${input.idempotencyKey}`)]),
      mimeType: input.base.mimeType as "image/png" | "image/jpeg" | "image/webp",
      originalName: `${input.idempotencyKey}.png`,
      latencyMs: Date.now() - started,
      usage: { total_tokens: 0, unpriced: true },
    };
  }
}

export class FakeVerifierProvider implements VerifierProvider {
  readonly id = "fake-verifier";

  constructor(private readonly passAfter = 3) {}

  async probe() { return { ok: true, message: "Fake Qwen ready" }; }

  async createChecklist(input: Parameters<VerifierProvider["createChecklist"]>[0]) {
    return {
      version: 1 as const,
      requirements: [{ id: "requirement-1", statement: input.task.user_brief, severity: "blocker" as const }],
      created_at: new Date().toISOString(),
      model: this.id,
    };
  }

  async verify(input: Parameters<VerifierProvider["verify"]>[0]) {
    const calls = input.attemptNumber;
    const passed = calls >= this.passAfter;
    return {
      status: passed ? "PASS" as const : "FAIL" as const,
      overall_score: passed ? 95 : Math.min(90, 30 + calls * 20),
      confidence: 0.95,
      requirements: input.checklist.requirements.map((requirement) => ({
        requirement_id: requirement.id,
        verdict: passed ? "PASS" as const : "FAIL" as const,
        score: passed ? 95 : Math.min(90, 30 + calls * 20),
        evidence: passed ? "Fake candidate meets the requirement." : "Fake candidate still misses the requirement.",
      })),
      preservation: { identity: 100, composition: 100, unaffected_regions: 100 },
      artifacts: [],
      feedback: passed ? [] : ["Continue iterating."],
      model: this.id,
      latency_ms: 0,
      usage: { total_tokens: 0, unpriced: true },
    };
  }

  async createEvaluationFrame(input: Parameters<VerifierProvider["createEvaluationFrame"]>[0]): Promise<EvaluationFrameRevision> {
    const createdAt = new Date().toISOString();
    const anchors = [
      "brief:user_brief",
      ...(input.task.checklist?.requirements.map((requirement) => `brief:requirement:${requirement.id}`) ?? []),
      ...input.publicReferences.map((_, index) => `media:public_reference:${index + 1}`),
      ...input.sealedReferences.map((_, index) => `media:sealed_reference:${index + 1}`),
      ...(input.hiddenTargetPath ? ["media:hidden_target"] : []),
      ...(input.privateInstructions ? ["private:instructions"] : []),
    ];
    return {
      id: `frame-${input.attempt}`,
      run_id: input.runId,
      attempt: input.attempt,
      revision: (input.previousFrame?.revision ?? 0) + 1,
      ...(input.previousFrame ? { supersedes_id: input.previousFrame.id } : {}),
      provenance: "verifier",
      axes: [{
        id: "axis-user-intent",
        label: "User intent",
        criterion: input.task.user_brief,
        mode: input.hiddenTargetPath ? "match_target" as const : "optimize" as const,
        importance: "blocker" as const,
        visibility: input.hiddenTargetPath ? "sealed" as const : "public" as const,
        anchor_refs: anchors,
        required_tools: input.hiddenTargetPath ? ["measure_target_alignment" as const] : [],
        regions: [],
      }],
      target_interpretation: {
        role: input.hiddenTargetPath ? "strong_target" as const : "none" as const,
        rationale: input.hiddenTargetPath ? "The hidden target is the primary direction of travel." : "No hidden target is configured.",
      },
      change_summary: input.previousFrame ? "Refreshed for the next autonomous invocation." : "Initial evaluation frame derived from human intent.",
      axis_diff: input.previousFrame
        ? { added: [], removed: [], changed: ["axis-user-intent"] }
        : { added: ["axis-user-intent"], removed: [], changed: [] },
      coverage: anchors.map((anchor_ref) => ({ anchor_ref, axis_ids: ["axis-user-intent"] })),
      reconsider_candidate_ids: [],
      model: this.id,
      created_at: createdAt,
    };
  }

  async compare(input: Parameters<VerifierProvider["compare"]>[0]): Promise<ComparativeVerifierDecision> {
    const required = new Set([
      "measure_integrity" as const,
      "measure_artifacts" as const,
      ...input.frame.axes.flatMap((axis) => axis.required_tools),
    ]);
    const evidence = [];
    for (const tool of required) evidence.push(await input.callTool(tool));
    const better = input.frame.attempt >= this.passAfter && input.technicalGate.passed;
    return {
      id: `decision-${input.draftId}-${input.frame.id}`,
      run_id: input.runId,
      draft_id: input.draftId,
      candidate_artifact_id: input.candidateArtifactId,
      incumbent_node_id: input.incumbentNode.id,
      incumbent_artifact_id: input.incumbentNode.artifact_id,
      evaluation_frame_revision_id: input.frame.id,
      correctness: better && input.technicalGate.passed ? "pass" as const : "fail" as const,
      technical_gate: input.technicalGate,
      preference: better ? "better" as const : "worse" as const,
      target_progress: better ? "improved" as const : "unchanged" as const,
      axis_judgments: input.frame.axes.map((axis) => ({
        axis_id: axis.id,
        verdict: better ? "pass" as const : "fail" as const,
        candidate_score: better ? 95 : 40,
        incumbent_score: better ? 80 : 60,
        evidence: better ? "The fake candidate is better than the incumbent." : "The fake candidate is not better than the incumbent.",
      })),
      confidence: 0.95,
      recommendation: better ? "commit" as const : "archive" as const,
      evidence_refs: evidence.map((item) => item.id),
      feedback_for_main_agent: better ? ["Submit this candidate."] : ["Revise before submitting."],
      private_feedback: [],
      evidence,
      adjudication_of: [],
      cache_key: `${input.candidateArtifactId}:${input.incumbentNode.artifact_id}:${input.frame.id}:fake`,
      model: this.id,
      usage: { total_tokens: 0, unpriced: true },
      latency_ms: 0,
      created_at: new Date().toISOString(),
    };
  }

  async selectFinal(input: Parameters<VerifierProvider["selectFinal"]>[0]): Promise<FinalVerifierDecision> {
    const selected = input.candidates.findLast((candidate) => candidate.origin !== "archive") ?? input.candidates[0]!;
    return {
      id: `final-${input.runId}-${input.frame.revision}`,
      run_id: input.runId,
      evaluation_frame_revision_id: input.frame.id,
      candidate_node_ids: input.candidates.map((candidate) => candidate.node.id),
      selected_node_id: selected.node.id,
      confidence: 0.95,
      rationale: "The deterministic fake verifier selects the latest accepted lineage version.",
      evidence_refs: selected.acceptedDecision?.evidence_refs ?? [],
      model: this.id,
      usage: { total_tokens: 0, unpriced: true },
      latency_ms: 0,
      created_at: new Date().toISOString(),
    };
  }
}
