import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  benchmarkSnapshotSchema,
  runEventSchema,
  runSnapshotSchema,
  taskManifestSchema,
  variationStepRecordSchema,
  type AgentSummary,
  type BenchmarkSnapshot,
  type RunEvent,
  type RunSnapshot,
  type TaskManifest,
} from "@avo/contracts";
import { assertSafeId } from "./ids.ts";

const atomicWrite = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
};

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

type SnapshotPatchOperation = {
  op: "add" | "replace" | "remove";
  path: Array<string | number>;
  value?: unknown;
};

const stripEventHydration = (event: RunEvent): RunEvent => {
  const { _snapshot: _snapshot, _snapshot_patch: _snapshotPatch, ...data } = event.data;
  return { ...event, data };
};

export class FileStateStore {
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly runSequences = new Map<string, number>();

  constructor(readonly dataDir: string) {}

  private taskPath(id: string) {
    return join(this.dataDir, "tasks", assertSafeId(id), "task.json");
  }

  private runDir(id: string) {
    return join(this.dataDir, "runs", assertSafeId(id));
  }

  private benchmarkPath(id: string) {
    return join(this.dataDir, "benchmarks", assertSafeId(id), "benchmark.json");
  }

  async saveTask(task: TaskManifest) {
    const parsed = taskManifestSchema.parse(task);
    await atomicWrite(this.taskPath(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async getTask(id: string) {
    return taskManifestSchema.parse(await readJson(this.taskPath(id)));
  }

  async listTasks() {
    const root = join(this.dataDir, "tasks");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const tasks = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.getTask(entry.name)));
    return tasks.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async createRun(snapshot: RunSnapshot) {
    const parsed = runSnapshotSchema.parse(snapshot);
    await mkdir(this.runDir(parsed.id), { recursive: true });
    await this.commitRun(parsed.id, "run.created", {}, () => parsed);
    return parsed;
  }

  async getRun(id: string): Promise<RunSnapshot> {
    const snapshotPath = join(this.runDir(id), "snapshot.json");
    try {
      const persisted = await readJson(snapshotPath);
      const persistedSequence = isPlainObject(persisted) && Number.isInteger(persisted._event_sequence)
        ? Number(persisted._event_sequence)
        : undefined;
      if (persistedSequence !== undefined) {
        const eventSequence = this.runSequences.get(id) ?? await this.readLastRunEventSequence(id);
        if (eventSequence !== persistedSequence) return this.rebuildRun(id);
      }
      const run = runSnapshotSchema.parse(persisted);
      if (run.variation_steps.length > 0 || (run.drafts.length === 0 && !run.agent_thread_id)) return run;
      const events = await this.listRunEvents(id).catch(() => []);
      const variationSteps = projectHistoricalVariationSteps(run, events);
      return {
        ...run,
        variation_steps: variationSteps,
        memory_pending: variationSteps.at(-1)?.memory_pending ?? run.memory_pending,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return this.rebuildRun(id);
  }

  async rebuildRun(id: string) {
    let hydrated: unknown;
    let sequence = 0;
    await this.forEachRunEvent(id, (event) => {
      sequence = event.sequence;
      if (event.data._snapshot !== undefined) {
        hydrated = event.data._snapshot;
        return;
      }
      if (event.data._snapshot_patch !== undefined) {
        if (hydrated === undefined) throw new Error("run_event_patch_without_snapshot");
        hydrated = applySnapshotPatch(hydrated, parseSnapshotPatch(event.data._snapshot_patch));
      }
    });
    if (hydrated === undefined) throw Object.assign(new Error("run_not_found"), { code: "ENOENT" });
    const snapshot = runSnapshotSchema.parse(hydrated);
    await atomicWrite(join(this.runDir(id), "snapshot.json"), `${JSON.stringify({ ...snapshot, _event_sequence: sequence }, null, 2)}\n`);
    this.runSequences.set(id, sequence);
    return snapshot;
  }

  async listRuns() {
    const root = join(this.dataDir, "runs");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.getRun(entry.name)));
    return runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async recoverInterruptedRuns() {
    const recoverable = (await this.listRuns()).filter((run) =>
      ["queued", "running", "stop_requested"].includes(run.status));
    for (const run of recoverable) {
      await this.commitRun(run.id, "run.recovered_interrupted", { previous_status: run.status }, (current) => {
        if (!current) throw new Error("run_not_found");
        const timestamp = new Date().toISOString();
        return {
          ...current,
          status: "interrupted",
          finished_at: timestamp,
          terminal_reason: "api_process_restarted",
          updated_at: timestamp,
        };
      });
    }
    return recoverable.map((run) => run.id);
  }

  async listRunEvents(id: string, options: { afterSequence?: number } = {}): Promise<RunEvent[]> {
    if ((options.afterSequence ?? 0) > 0) return this.listRunEventsAfter(id, options.afterSequence!);
    const events: RunEvent[] = [];
    await this.forEachRunEvent(id, (event) => { events.push(stripEventHydration(event)); });
    return events;
  }

  async commitRun(
    id: string,
    type: string,
    data: Record<string, unknown>,
    mutate: (current: RunSnapshot | undefined) => RunSnapshot,
  ): Promise<RunSnapshot> {
    return this.withRunLock(id, async () => {
      let current: RunSnapshot | undefined;
      try {
        current = await this.getRun(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as Error).message !== "run_not_found") throw error;
      }
      const next = runSnapshotSchema.parse(mutate(current));
      const sequence = (this.runSequences.get(id) ?? await this.readLastRunEventSequence(id)) + 1;
      const { _snapshot: _ignoredSnapshot, _snapshot_patch: _ignoredPatch, ...eventData } = data;
      const event = runEventSchema.parse({
        sequence,
        run_id: id,
        type,
        at: new Date().toISOString(),
        data: current
          ? { ...eventData, _snapshot_patch: createSnapshotPatch(current, next) }
          : { ...eventData, _snapshot: next },
      });
      await mkdir(this.runDir(id), { recursive: true });
      const eventLog = await open(join(this.runDir(id), "events.jsonl"), "a");
      try {
        await eventLog.writeFile(`${JSON.stringify(event)}\n`);
        await eventLog.sync();
      } finally {
        await eventLog.close();
      }
      await atomicWrite(
        join(this.runDir(id), "snapshot.json"),
        `${JSON.stringify({ ...next, _event_sequence: sequence }, null, 2)}\n`,
      );
      this.runSequences.set(id, sequence);
      return next;
    });
  }

  async deleteRun(id: string) {
    await rm(this.runDir(id), { recursive: true, force: true });
    this.runSequences.delete(id);
  }

  async saveBenchmark(benchmark: BenchmarkSnapshot) {
    const parsed = benchmarkSnapshotSchema.parse(benchmark);
    await atomicWrite(this.benchmarkPath(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async getBenchmark(id: string) {
    return benchmarkSnapshotSchema.parse(await readJson(this.benchmarkPath(id)));
  }

  async listBenchmarks() {
    const root = join(this.dataDir, "benchmarks");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const items = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.getBenchmark(entry.name)));
    return items.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async recoverInterruptedBenchmarks() {
    const recoverable = (await this.listBenchmarks()).filter((benchmark) =>
      ["queued", "running"].includes(benchmark.status));
    for (const benchmark of recoverable) {
      await this.saveBenchmark({
        ...benchmark,
        status: "failed",
        updated_at: new Date().toISOString(),
      });
    }
    return recoverable.map((benchmark) => benchmark.id);
  }

  private async withRunLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(id) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => next);
    this.runLocks.set(id, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.runLocks.get(id) === queued) this.runLocks.delete(id);
    }
  }

  private async forEachRunEvent(id: string, visit: (event: RunEvent) => void | Promise<void>) {
    const stream = createReadStream(join(this.runDir(id), "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        await visit(runEventSchema.parse(JSON.parse(line)));
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async listRunEventsAfter(id: string, afterSequence: number) {
    const events: RunEvent[] = [];
    await this.forEachRunEventReverse(id, (event) => {
      if (event.sequence <= afterSequence) return false;
      events.push(stripEventHydration(event));
      return true;
    });
    return events.reverse();
  }

  private async readLastRunEventSequence(id: string) {
    let sequence = 0;
    try {
      await this.forEachRunEventReverse(id, (event) => {
        sequence = event.sequence;
        return false;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.runSequences.set(id, sequence);
    return sequence;
  }

  private async forEachRunEventReverse(id: string, visit: (event: RunEvent) => boolean | void) {
    const handle = await open(join(this.runDir(id), "events.jsonl"), "r");
    try {
      const { size } = await handle.stat();
      const chunkSize = 64 * 1024;
      let position = size;
      let remainder = Buffer.alloc(0);
      while (position > 0) {
        const length = Math.min(chunkSize, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        await handle.read(chunk, 0, length, position);
        const combined = Buffer.concat([chunk, remainder]);
        let end = combined.length;
        for (let index = combined.length - 1; index >= 0; index -= 1) {
          if (combined[index] !== 0x0a) continue;
          const line = combined.subarray(index + 1, end);
          end = index;
          if (line.length === 0) continue;
          const event = runEventSchema.parse(JSON.parse(line.toString("utf8")));
          if (visit(event) === false) return;
        }
        remainder = Buffer.from(combined.subarray(0, end));
      }
      if (remainder.length > 0) {
        visit(runEventSchema.parse(JSON.parse(remainder.toString("utf8"))));
      }
    } finally {
      await handle.close();
    }
  }
}

const createSnapshotPatch = (before: unknown, after: unknown) => {
  const operations: SnapshotPatchOperation[] = [];
  diffSnapshot(before, after, [], operations);
  return operations;
};

const diffSnapshot = (
  before: unknown,
  after: unknown,
  path: Array<string | number>,
  operations: SnapshotPatchOperation[],
) => {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      diffSnapshot(before[index], after[index], [...path, index], operations);
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      operations.push({ op: "remove", path: [...path, index] });
    }
    for (let index = before.length; index < after.length; index += 1) {
      operations.push({ op: "add", path: [...path, index], value: after[index] });
    }
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) operations.push({ op: "remove", path: [...path, key] });
    }
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) operations.push({ op: "add", path: [...path, key], value });
      else diffSnapshot(before[key], value, [...path, key], operations);
    }
    return;
  }
  operations.push({ op: "replace", path, value: after });
};

const applySnapshotPatch = (snapshot: unknown, operations: SnapshotPatchOperation[]) => {
  let result = structuredClone(snapshot);
  for (const operation of operations) {
    if (operation.path.length === 0) {
      if (operation.op === "remove") throw new Error("invalid_root_snapshot_patch");
      result = structuredClone(operation.value);
      continue;
    }
    const parent = resolvePatchParent(result, operation.path);
    const key = operation.path.at(-1)!;
    if (Array.isArray(parent) && typeof key === "number") {
      if (operation.op === "remove") parent.splice(key, 1);
      else if (operation.op === "add") parent.splice(key, 0, structuredClone(operation.value));
      else parent[key] = structuredClone(operation.value);
      continue;
    }
    if (!isPlainObject(parent) || typeof key !== "string" || isUnsafePatchKey(key)) {
      throw new Error("invalid_snapshot_patch_path");
    }
    if (operation.op === "remove") delete parent[key];
    else parent[key] = structuredClone(operation.value);
  }
  return result;
};

const resolvePatchParent = (root: unknown, path: Array<string | number>) => {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isPlainObject(current) && typeof key === "string" && !isUnsafePatchKey(key)) current = current[key];
    else throw new Error("invalid_snapshot_patch_path");
  }
  return current;
};

const parseSnapshotPatch = (value: unknown): SnapshotPatchOperation[] => {
  if (!Array.isArray(value)) throw new Error("invalid_snapshot_patch");
  return value.map((item) => {
    if (!isPlainObject(item) || !["add", "replace", "remove"].includes(String(item.op)) || !Array.isArray(item.path)) {
      throw new Error("invalid_snapshot_patch");
    }
    const path = item.path.map((part) => {
      if ((typeof part !== "string" && typeof part !== "number") || (typeof part === "string" && isUnsafePatchKey(part))) {
        throw new Error("invalid_snapshot_patch_path");
      }
      return part;
    });
    return {
      op: item.op as SnapshotPatchOperation["op"],
      path,
      ...(item.op === "remove" ? {} : { value: item.value }),
    };
  });
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isUnsafePatchKey = (key: string) => key === "__proto__" || key === "prototype" || key === "constructor";

const projectHistoricalVariationSteps = (run: RunSnapshot, events: RunEvent[]) => {
  const steps = new Set<number>(run.drafts.map((draft) => draft.round));
  for (const event of events) {
    const step = Number(event.data.variation_step);
    if (Number.isInteger(step) && step > 0) steps.add(step);
  }
  if (["running", "stop_requested", "interrupted", "failed"].includes(run.status)) {
    steps.add(run.active_variation_step);
  }
  return [...steps].sort((left, right) => left - right).map((step) => {
    const drafts = run.drafts.filter((draft) => draft.round === step);
    const draftIds = new Set(drafts.map((draft) => draft.id));
    const evaluations = run.evaluations.filter((evaluation) => draftIds.has(evaluation.draft_id));
    const attempt = run.attempts.find((item) => item.draft_id && draftIds.has(item.draft_id));
    const start = events.find((event) => (event.type === "variation_step.started" || event.type === "agent.step_started")
      && Number(event.data.variation_step) === step);
    const abandoned = events.findLast((event) => (event.type === "variation_step.abandoned" || event.type === "variation_step.recorded")
      && Number(event.data.variation_step) === step);
    const nextStart = events.find((event) => (event.type === "variation_step.started" || event.type === "agent.step_started")
      && Number(event.data.variation_step) === step + 1);
    const reason = String(abandoned?.data.reason ?? abandoned?.data.terminal_reason ?? (step === run.active_variation_step ? run.terminal_reason ?? "" : ""));
    const status = attempt
      ? "submitted" as const
      : /token_budget|tool_call_limit|timeout|runtime_cutoff/i.test(reason) || (step < run.active_variation_step && !abandoned)
        ? "runtime_cutoff" as const
        : step === run.active_variation_step && ["failed", "interrupted"].includes(run.status)
          ? "failed" as const
          : step === run.active_variation_step && ["running", "stop_requested"].includes(run.status)
            ? "running" as const
            : "abandoned" as const;
    const eventSummary = abandoned?.data.summary;
    const summary = isAgentSummary(eventSummary)
      ? eventSummary
      : attempt?.agent_summary ?? historicalStepSummary(reason || status);
    const firstDraft = drafts[0];
    const parentNode = firstDraft
      ? run.lineage_nodes.find((node) => node.artifact_id === firstDraft.parent_artifact_id)
        ?? run.drafts.find((draft) => draft.artifact_id === firstDraft.parent_artifact_id)
      : undefined;
    const parentSelection = firstDraft && parentNode ? {
      parent_node_id: parentNode.id,
      artifact_id: firstDraft.parent_artifact_id,
      kind: "kind" in parentNode && parentNode.kind === "commit" ? "commit" as const
        : "kind" in parentNode && parentNode.kind === "seed" ? "source" as const
          : "draft" as const,
      rationale: "Recovered from historical Draft ancestry.",
      ancestry_depth: "ancestry_depth" in parentNode ? parentNode.ancestry_depth : 0,
      source_debt_severe_count: 0,
      step_debt_severe_count: 0,
      selected_at: firstDraft.created_at,
    } : undefined;
    const memoryRevision = run.memory_revisions.findLast((revision) => revision.created_at >= (start?.at ?? run.created_at)
      && revision.created_at <= (abandoned?.at ?? nextStart?.at ?? run.finished_at ?? run.updated_at));
    const lineageNode = run.lineage_nodes.find((node) => node.draft_id && draftIds.has(node.draft_id));
    return variationStepRecordSchema.parse({
      id: `variation-step-${step}`,
      step,
      status,
      ...(parentSelection ? { parent_selection: parentSelection } : {}),
      reference_artifact_ids: firstDraft?.generation_input.reference_artifact_ids ?? [],
      prompt_revision_ids: [...new Set(drafts.flatMap((draft) => run.prompt_revisions
        .filter((prompt) => prompt.value === draft.prompt)
        .map((prompt) => `prompt-${prompt.revision}`)))],
      draft_ids: drafts.map((draft) => draft.id),
      evaluation_ids: evaluations.map((evaluation) => evaluation.id),
      ...(attempt?.draft_id ? { selected_draft_id: attempt.draft_id } : {}),
      ...(lineageNode ? { lineage_node_id: lineageNode.id } : {}),
      summary,
      ...(memoryRevision ? { memory_revision_id: memoryRevision.id } : {}),
      memory_pending: !memoryRevision,
      usage_delta: {},
      started_at: start?.at ?? firstDraft?.created_at ?? run.started_at ?? run.created_at,
      ...((status !== "running") ? { finished_at: abandoned?.at ?? nextStart?.at ?? run.finished_at ?? run.updated_at } : {}),
      ...(reason ? { terminal_reason: reason } : {}),
    });
  });
};

const isAgentSummary = (value: unknown): value is AgentSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [record.observation, record.hypothesis, record.intervention].every((item) => typeof item === "string" && item.length > 0);
};

const historicalStepSummary = (reason: string): AgentSummary => ({
  observation: reason ? `Historical Step ended with ${reason}.` : "Historical Step was reconstructed from persisted Draft events.",
  hypothesis: "Persisted Drafts and evaluations remain valid trajectory evidence.",
  intervention: "Projected the historical Step without rewriting its event log.",
});
