import { readFile } from "node:fs/promises";
import type { AgentProvider, AgentRoundContext, AgentToolbox, ImageProvider, VerifierProvider } from "./providers.ts";

export class FakeAgentProvider implements AgentProvider {
  readonly id = "fake-agent";

  async probe() { return { ok: true, message: "Fake Codex ready" }; }

  async runRound(context: AgentRoundContext, tools: AgentToolbox) {
    const round = context.run.attempts.length + 1;
    tools.setPrompt(`${context.task.request}\n\nIteration ${round}: preserve the source composition and satisfy every requirement.`);
    tools.selectGenerationInputs({
      base_artifact_id: context.run.best_failed_attempt_id
        ? context.run.attempts.find((attempt) => attempt.id === context.run.best_failed_attempt_id)?.generated_artifact_id
          ?? context.task.source_artifact_id
        : context.task.source_artifact_id,
      reference_artifact_ids: context.task.references.map((reference) => reference.artifact_id),
    });
    const artifactId = await tools.generateImage();
    tools.submitCandidate(artifactId, {
      observation: round === 1 ? "No prior candidate exists." : "The previous candidate still missed requirements.",
      hypothesis: "A focused preservation instruction should improve the next result.",
      intervention: `Generated deterministic fake candidate ${round}.`,
    });
  }

  async planBestOf(context: AgentRoundContext, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      prompt: `${context.task.request}\n\nIndependent no-feedback variant ${index + 1}.`,
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

  async supervise() {
    return {
      diagnosis: "Three candidates failed without resolving the primary requirement.",
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
      bytes: source,
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
      requirements: [{ id: "requirement-1", statement: input.task.request, severity: "blocker" as const }],
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
}
