import {
  benchmarkSnapshotSchema,
  runConfigSchema,
  usageSchema,
  type BenchmarkSnapshot,
  type RunMode,
  type Usage,
} from "@avo/contracts";
import { AvoRunner, createId, FileStateStore } from "@avo/core";

const now = () => new Date().toISOString();

const shuffled = <T>(items: T[]) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
};

export class BenchmarkRunner {
  private active: Promise<void> | undefined;

  constructor(
    private readonly store: FileStateStore,
    private readonly runner: AvoRunner,
    private readonly runDefaults: Partial<ReturnType<typeof runConfigSchema.parse>> = {},
  ) {}

  async create(taskIds: string[]) {
    await Promise.all(taskIds.map((id) => this.store.getTask(id)));
    const modes: RunMode[] = ["one_shot", "best_of_n", "avo"];
    const schedule = taskIds.flatMap((taskId) => shuffled(modes).map((mode) => ({ task_id: taskId, mode })));
    const createdAt = now();
    const benchmark = benchmarkSnapshotSchema.parse({
      schema_version: 1,
      id: createId("benchmark"),
      task_ids: taskIds,
      status: "queued",
      schedule,
      run_ids: [],
      created_at: createdAt,
      updated_at: createdAt,
    });
    await this.store.saveBenchmark(benchmark);
    return benchmark;
  }

  start(id: string) {
    if (this.active) throw new Error("benchmark_scheduler_busy");
    this.active = this.execute(id).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async execute(id: string) {
    let benchmark = await this.store.getBenchmark(id);
    benchmark = await this.store.saveBenchmark({ ...benchmark, status: "running", updated_at: now() });
    try {
      for (const item of benchmark.schedule) {
        const config = runConfigSchema.parse({
          mode: item.mode,
          max_generations: item.mode === "one_shot" ? 1 : 24,
          max_generations_per_round: item.mode === "best_of_n" ? 1 : 2,
          ...this.runDefaults,
        });
        const run = await this.runner.createRun(item.task_id, config);
        benchmark = await this.store.saveBenchmark({
          ...benchmark,
          run_ids: [...benchmark.run_ids, run.id],
          updated_at: now(),
        });
        await this.runner.start(run.id);
      }
      await this.store.saveBenchmark({ ...benchmark, status: "completed", updated_at: now() });
    } catch (error) {
      await this.store.saveBenchmark({ ...benchmark, status: "failed", updated_at: now() });
      throw error;
    }
  }

  async report(benchmark: BenchmarkSnapshot) {
    const runs = await Promise.all(benchmark.run_ids.map((id) => this.store.getRun(id)));
    const eventsByRun = await Promise.all(runs.map((run) => this.store.listRunEvents(run.id)));
    const rows = runs.map((run, runIndex) => {
      const generationEvents = eventsByRun[runIndex]!.filter((event) => event.type === "generation.completed");
      const generationOrder = new Map(generationEvents.map((event, index) => [event.data.artifact_id, index + 1]));
      const firstPassGeneration = Math.min(
        Number.POSITIVE_INFINITY,
        ...run.attempts
          .filter((attempt) => attempt.status === "passed")
          .map((attempt) => generationOrder.get(attempt.generated_artifact_id) ?? Number.POSITIVE_INFINITY),
      );
      const generationUsages = generationEvents.flatMap((event) => {
        const parsed = usageSchema.safeParse(event.data.usage);
        return parsed.success ? [parsed.data] : [];
      });
      const verifierUsages = run.attempts.flatMap((attempt) => attempt.verification?.usage ? [attempt.verification.usage] : []);
      const usage = sumUsage([...generationUsages, ...verifierUsages]);
      const totalLatencyMs = generationEvents.reduce(
        (sum, event) => sum + numeric(event.data.latency_ms),
        run.attempts.reduce((sum, attempt) => sum + (attempt.verification?.latency_ms ?? 0), 0),
      );
      const prefixCurve = Array.from({ length: 24 }, (_, index) => {
        const budget = index + 1;
        const eligibleAttempts = run.attempts.filter((attempt) =>
          (generationOrder.get(attempt.generated_artifact_id) ?? Number.POSITIVE_INFINITY) <= budget);
        return {
          budget,
          passed: firstPassGeneration <= budget,
          best_score: Math.max(-1, ...eligibleAttempts.map((attempt) => attempt.verification?.overall_score ?? -1)),
        };
      });
      return {
        run_id: run.id,
        task_id: run.task_id,
        mode: run.config.mode,
        status: run.status,
        passed: run.lineage_attempt_ids.length > 0,
        generation_count: run.generation_count,
        verifier_count: run.verifier_count,
        best_score: Math.max(-1, ...run.attempts.map((attempt) => attempt.verification?.overall_score ?? -1)),
        first_pass_generation: Number.isFinite(firstPassGeneration) ? firstPassGeneration : null,
        total_latency_ms: totalLatencyMs,
        usage,
        prefix_curve: prefixCurve,
        models: {
          main: run.config.main_model,
          generator: run.config.generator_model,
          verifier: run.config.verifier_model,
        },
        provider_revisions: run.config.provider_revisions,
        terminal_reason: run.terminal_reason,
      };
    });
    return {
      benchmark,
      rows,
      aggregate: ["one_shot", "best_of_n", "avo"].map((mode) => {
        const matching = rows.filter((row) => row.mode === mode);
        return {
          mode,
          tasks: matching.length,
          passes: matching.filter((row) => row.passed).length,
          average_generations: matching.length
            ? matching.reduce((sum, row) => sum + row.generation_count, 0) / matching.length
            : 0,
          average_best_score: matching.length
            ? matching.reduce((sum, row) => sum + Math.max(0, row.best_score), 0) / matching.length
            : 0,
          average_latency_ms: matching.length
            ? matching.reduce((sum, row) => sum + row.total_latency_ms, 0) / matching.length
            : 0,
          estimated_cost_usd: matching.reduce((sum, row) => sum + (row.usage.estimated_cost_usd ?? 0), 0),
          unpriced: matching.some((row) => row.usage.unpriced),
        };
      }),
    };
  }
}

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

const sumUsage = (usages: Usage[]): Usage => {
  const sumField = (field: keyof Omit<Usage, "unpriced">) => {
    const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const inputTokens = sumField("input_tokens");
  const outputTokens = sumField("output_tokens");
  const imageTokens = sumField("image_tokens");
  const totalTokens = sumField("total_tokens");
  const estimatedCost = sumField("estimated_cost_usd");
  return usageSchema.parse({
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(imageTokens !== undefined ? { image_tokens: imageTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(estimatedCost !== undefined ? { estimated_cost_usd: estimatedCost } : {}),
    unpriced: usages.length === 0 || usages.some((usage) => usage.unpriced || usage.estimated_cost_usd === undefined),
  });
};
