import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  benchmarkSnapshotSchema,
  runEventSchema,
  runSnapshotSchema,
  taskManifestSchema,
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

export class FileStateStore {
  private readonly runLocks = new Map<string, Promise<void>>();

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
      return runSnapshotSchema.parse(await readJson(snapshotPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return this.rebuildRun(id);
  }

  async rebuildRun(id: string) {
    const events = await this.listRunEvents(id);
    const last = events.at(-1);
    if (!last) throw Object.assign(new Error("run_not_found"), { code: "ENOENT" });
    const snapshot = runSnapshotSchema.parse(last.data._snapshot);
    await atomicWrite(join(this.runDir(id), "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
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

  async listRunEvents(id: string): Promise<RunEvent[]> {
    const contents = await readFile(join(this.runDir(id), "events.jsonl"), "utf8");
    return contents.split("\n").filter(Boolean).map((line) => runEventSchema.parse(JSON.parse(line)));
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
      const events = current ? await this.listRunEvents(id) : [];
      const event = runEventSchema.parse({
        sequence: events.length + 1,
        run_id: id,
        type,
        at: new Date().toISOString(),
        data: { ...data, _snapshot: next },
      });
      await mkdir(this.runDir(id), { recursive: true });
      await atomicWrite(
        join(this.runDir(id), "events.jsonl"),
        `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      await atomicWrite(join(this.runDir(id), "snapshot.json"), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  async deleteRun(id: string) {
    await rm(this.runDir(id), { recursive: true, force: true });
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
}
