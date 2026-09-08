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
    private readonly concurrency = 3,
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
      const scheduledRuns: Array<{ taskId: string; runId: string }> = [];
      for (const item of benchmark.schedule) {
        const config = runConfigSchema.parse({
          mode: item.mode,
          max_generations: item.mode === "one_shot" ? 1 : 24,
          max_generations_per_round: 24,
          ...this.runDefaults,
        });
        const run = await this.runner.createRun(item.task_id, config);
        scheduledRuns.push({ taskId: item.task_id, runId: run.id });
      }
      benchmark = await this.store.saveBenchmark({
        ...benchmark,
        run_ids: scheduledRuns.map((item) => item.runId),
        updated_at: now(),
      });
      const taskQueues = [...new Set(benchmark.task_ids)].map((taskId) =>
        scheduledRuns.filter((item) => item.taskId === taskId));
      await runWithConcurrency(taskQueues, this.concurrency, async (queue) => {
        for (const item of queue) await this.runner.start(item.runId);
      });
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
      const generationEvents = eventsByRun[runIndex]!.filter((event) =>
        event.type === "generation.completed" || event.type === "draft.generated" || event.type === "draft.rejected_preverify");
      const generationOrder = new Map(generationEvents.map((event, index) => {
        const draft = event.data.draft as { artifact_id?: string } | undefined;
        return [draft?.artifact_id ?? event.data.artifact_id, index + 1];
      }));
      const acceptedNodes = run.lineage_nodes.filter((node) => node.kind === "commit");
      const firstPassGeneration = Math.min(
        Number.POSITIVE_INFINITY,
        ...acceptedNodes.map((node) => generationOrder.get(node.artifact_id) ?? Number.POSITIVE_INFINITY),
      );
      const generationUsages = generationEvents.flatMap((event) => {
        const draft = event.data.draft as { usage?: unknown } | undefined;
        const parsed = usageSchema.safeParse(draft?.usage ?? event.data.usage);
        return parsed.success ? [parsed.data] : [];
      });
      const verifierUsages = [
        ...run.comparative_decisions.flatMap((decision) => decision.usage ? [decision.usage] : []),
        ...run.final_verifier_decisions.flatMap((decision) => decision.usage ? [decision.usage] : []),
      ];
      const usage = sumUsage([...generationUsages, ...verifierUsages]);
      const totalLatencyMs = generationEvents.reduce(
        (sum, event) => sum + numeric((event.data.draft as { latency_ms?: unknown } | undefined)?.latency_ms ?? event.data.latency_ms),
        run.comparative_decisions.reduce((sum, decision) => sum + decision.latency_ms, 0)
          + run.final_verifier_decisions.reduce((sum, decision) => sum + decision.latency_ms, 0),
      );
      const finalDecision = run.final_verifier_decision_id
        ? run.final_verifier_decisions.find((decision) => decision.id === run.final_verifier_decision_id)
        : undefined;
      const finalNode = finalDecision
        ? run.lineage_nodes.find((node) => node.id === finalDecision.selected_node_id)
        : undefined;
      const prefixCurve = Array.from({ length: 24 }, (_, index) => {
        const budget = index + 1;
        const acceptedWithinBudget = acceptedNodes.filter((node) =>
          (generationOrder.get(node.artifact_id) ?? Number.POSITIVE_INFINITY) <= budget);
        return {
          budget,
          passed: firstPassGeneration <= budget,
          best_score: acceptedWithinBudget.length > 0 ? Math.round((finalDecision?.confidence ?? 0) * 100) : -1,
        };
      });
      return {
        run_id: run.id,
        task_id: run.task_id,
        mode: run.config.mode,
        status: run.status,
        passed: Boolean(finalDecision && finalNode && (finalNode.version ?? 0) > 0),
        generation_count: run.generation_count,
        verifier_count: run.verifier_count,
        best_score: finalDecision ? Math.round(finalDecision.confidence * 100) : -1,
        final_version: finalNode?.version ?? 0,
        final_node_id: finalNode?.id ?? null,
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

const runWithConcurrency = async <T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>) => {
  let cursor = 0;
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await operation(items[index]!);
      } catch (error) {
        errors.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
};

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
