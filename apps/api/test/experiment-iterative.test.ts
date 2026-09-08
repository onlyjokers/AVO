import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { candidateDraftSchema, runSnapshotSchema, taskManifestSchema } from "@avo/contracts";
import type { AgentToolbox, ImagePoolItem } from "@avo/core";
import { ArtifactStore, AvoRunner, FakeAgentProvider, FakeImageProvider, FakeVerifierProvider, FileStateStore } from "@avo/core";
import sharp from "sharp";
import { createIterativeState, iterativeContext, IterativeSearch, type IterativeCheckpoint } from "../src/experiment-iterative.ts";

const at = new Date().toISOString();
const fresh = (trajectory = "layout", strategy = "layout-first") => ({
  action: "FRESH_START", trajectory, strategy, prompt: `Apply ${strategy} while preserving source details.`, rationale: "Explore an independent approach.",
});
const next = (trajectory = "layout") => ({ action: "CONTINUE", trajectory, prompt: "Refine local detail.", rationale: "Preserve successful work." });

function fixture(limit = 6) {
  const run = runSnapshotSchema.parse({ schema_version: 4, id: "run-one", task_id: "task-one", config: { mode: "avo", max_generations: limit },
    status: "running", active_round: 1, drafts: [], attempts: [], lineage_attempt_ids: [], working_memory: {},
    lineage_nodes: [{ id: "seed", run_id: "run-one", kind: "seed", version: 0, artifact_id: `sha256:${"a".repeat(64)}`, ancestry_depth: 0,
      pareto_active: false, committed_at: at }],
    human_intent_revision: "brief-v1", incumbent_node_id: "seed", consecutive_failures: 0, generation_count: 0, verifier_count: 0,
    created_at: at, updated_at: at });
  // Short readable identifiers in the unit double; integration below uses actual content hashes.
  run.lineage_nodes[0]!.artifact_id = "source";
  const pool: ImagePoolItem[] = [{ artifactId: "source", kind: "source", path: "/source.png" }, { artifactId: "reference", kind: "reference", path: "/public.png" }];
  const events: IterativeCheckpoint[] = [];
  const calls: string[] = [];
  let parent = "source";
  let references: string[] = [];
  let prompt = "";
  const toolbox: Pick<AgentToolbox, "getRunSnapshot" | "listImagePool" | "selectParent" | "selectReferences" | "setPrompt" | "generateImage" | "signalStop"> = {
    getRunSnapshot: () => run,
    listImagePool: async () => pool,
    selectParent: async (id, rationale) => {
      calls.push("parent");
      parent = id === "seed" ? "source" : run.drafts.find((draft) => draft.id === id)!.artifact_id;
      return { parent_node_id: id, artifact_id: parent, kind: id === "seed" ? "source" : "draft", rationale,
        ancestry_depth: 0, source_debt_severe_count: 0, step_debt_severe_count: 0, selected_at: at };
    },
    selectReferences: async (ids) => { calls.push("references"); references = ids; },
    setPrompt: async (value) => { calls.push("prompt"); prompt = value; },
    generateImage: async () => {
      calls.push("generate");
      run.generation_count++;
      const id = `image-${run.generation_count}`;
      const dimensions = { width: 64, height: 48 };
      const draft = candidateDraftSchema.parse({ id: `draft-${run.generation_count}`, round: 1, status: "generated",
        artifact_id: `sha256:${"b".repeat(64)}`, raw_artifact_id: `sha256:${"b".repeat(64)}`, parent_artifact_id: `sha256:${"a".repeat(64)}`, prompt,
        generation_input: { base_artifact_id: `sha256:${"a".repeat(64)}`, reference_artifact_ids: [] },
        dimensions: { source: dimensions, provider: dimensions, final: dimensions, normalized: false }, latency_ms: 1, created_at: at });
      run.drafts.push({ ...draft, artifact_id: id, raw_artifact_id: id, parent_artifact_id: parent,
        generation_input: { base_artifact_id: parent, reference_artifact_ids: references } });
      pool.push({ artifactId: id, kind: "draft", path: `/${id}.png` });
      return id;
    },
    signalStop: () => { calls.push("stop"); },
  };
  const tools = toolbox as AgentToolbox;
  const checkpoint = async (event: IterativeCheckpoint) => { events.push(event); };
  const search = new IterativeSearch({ enabled: true, checkpoint });
  const reviewed = () => {
    for (const draft of run.drafts) {
      draft.viewed_at = at;
      // Only the linkage is consumed by this unit fixture; real evaluation is exercised below.
      if (!run.evaluations.some((item) => item.artifact_id === draft.artifact_id)) run.evaluations.push({ artifact_id: draft.artifact_id } as typeof run.evaluations[number]);
    }
  };
  return { run, pool, events, calls, tools, checkpoint, search, reviewed };
}

test("real actions preserve separate paths/history and STOP never selects a score maximum", async () => {
  const f = fixture();
  await f.search.execute(f.tools, fresh()); f.reviewed();
  await f.search.execute(f.tools, next()); f.reviewed();
  await f.search.execute(f.tools, { ...next(), action: "BACKTRACK", base_artifact_id: "source" }); f.reviewed();
  await f.search.execute(f.tools, fresh("lighting", "lighting-first"));
  const state = f.search.snapshot()!;
  assert.deepEqual(state.trajectories[0]!.path, ["source", "image-3"]);
  assert.deepEqual(state.trajectories[0]!.history.map((fact) => fact.artifact_id), ["image-1", "image-2", "image-3"]);
  assert.deepEqual(state.trajectories[1]!.path, ["source", "image-4"]);
  assert.equal(state.extra_generation_charges, 0);
  await f.search.execute(f.tools, { action: "STOP", trajectory: "layout", rationale: "Enough work on this branch." });
  assert.equal(f.calls.includes("stop"), false);
  await f.search.execute(f.tools, { action: "STOP", trajectory: "lighting", scope: "search", rationale: "Return to normal finalization." });
  assert.equal(f.calls.at(-1), "stop");
  assert.equal(f.run.final_lineage_node_id, undefined);
  assert.equal(f.events.filter((event) => event.data.phase === "reserved").length, 4);
  await assert.rejects(f.search.execute(f.tools, next()), /search_stopped/);
});

test("disabled execution and context leave the baseline untouched", async () => {
  const f = fixture();
  const search = new IterativeSearch({ enabled: false, checkpoint: f.checkpoint });
  await assert.rejects(search.execute(f.tools, fresh()), /disabled/);
  assert.equal(iterativeContext(false, f.run), "");
  assert.equal(search.snapshot(), undefined);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);
});

test("hidden references and arbitrary paths fail before any mutating tool call", async () => {
  const f = fixture();
  await assert.rejects(f.search.execute(f.tools, { ...fresh(), reference_artifact_ids: ["hidden-target"] }), /not_main_visible/);
  await assert.rejects(f.search.execute(f.tools, { ...fresh(), base_artifact_id: "hidden-target" }));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);
  await f.search.execute(f.tools, { ...fresh(), reference_artifact_ids: ["reference"] });
  const context = iterativeContext(true, { ...f.run, private_rubric: "SECRET", hidden_target_path: "/SECRET.png" } as typeof f.run, f.search.snapshot(), f.pool);
  assert.doesNotMatch(context, /SECRET|public.png|source.png|private_rubric/);
  const forged = f.search.snapshot()!;
  forged.trajectories[0]!.path.push("hidden-target");
  assert.throws(() => iterativeContext(true, f.run, forged, f.pool), /not_main_visible/);
});

test("backtracking rejects another trajectory, a discarded branch, and invalid drafts", async () => {
  const f = fixture(8);
  await f.search.execute(f.tools, fresh()); f.reviewed();
  await f.search.execute(f.tools, next()); f.reviewed();
  await f.search.execute(f.tools, { ...next(), action: "BACKTRACK", base_artifact_id: "source" }); f.reviewed();
  await f.search.execute(f.tools, fresh("other", "color-first")); f.reviewed();
  for (const id of ["image-2", "image-4", "hidden-target", "image-3"]) {
    await assert.rejects(f.search.execute(f.tools, { ...next(), action: "BACKTRACK", base_artifact_id: id }), /path_ancestor/);
  }
  f.run.drafts.find((draft) => draft.artifact_id === "image-3")!.status = "ambiguous";
  await assert.rejects(f.search.execute(f.tools, next()), /not_selectable/);
  assert.equal(f.run.generation_count, 4);
});

test("multi-start reserves shared budget, requires diversification, and does not bypass review", async () => {
  const f = fixture(2);
  await f.search.execute(f.tools, fresh());
  await assert.rejects(f.search.execute(f.tools, fresh("other", "color-first")), /view_and_evaluation/);
  f.reviewed();
  await assert.rejects(f.search.execute(f.tools, next()), /reserved_for_new_starts/);
  await assert.rejects(f.search.execute(f.tools, fresh("other", " LAYOUT-first ")), /distinct_strategy/);
  await f.search.execute(f.tools, fresh("other", "color-first")); f.reviewed();
  await assert.rejects(f.search.execute(f.tools, next()), /generation_budget_exhausted/);
  assert.equal(f.run.generation_count, 2);
});

test("run, round, token, time and decision limits block image calls", async () => {
  for (const [change, expected] of [
    [(f: ReturnType<typeof fixture>) => { f.run.generation_count = 6; }, /generation_budget/],
    [(f: ReturnType<typeof fixture>) => { f.run.status = "stop_requested"; }, /not_running/],
    [(f: ReturnType<typeof fixture>) => { f.run.started_at = "2000-01-01T00:00:00Z"; }, /wall_time/],
    [(f: ReturnType<typeof fixture>) => { f.run.config.max_agent_tokens = 10_000; f.run.agent_total_tokens = 10_000; }, /token_budget/],
    [(f: ReturnType<typeof fixture>) => { f.run.step_deadline = { started_at: at, soft_deadline_at: at, hard_deadline_at: at, state: "decision_only" }; }, /decision_only/],
    [(f: ReturnType<typeof fixture>) => { f.run.pending_decision = { source_step: 1, draft_ids: [], evaluation_ids: [], reason: "pending", created_at: at }; }, /decision_required/],
  ] as const) {
    const f = fixture(); change(f);
    await assert.rejects(f.search.execute(f.tools, fresh()), expected);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.run.config.max_generations_per_round = 1;
  await f.search.execute(f.tools, fresh()); f.reviewed();
  await assert.rejects(f.search.execute(f.tools, next()), /variation_attempt_generation_budget/);
});

test("durable state resumes across sessions but cannot cross runs or replay pending calls", async () => {
  const f = fixture();
  await f.search.execute(f.tools, fresh()); f.reviewed();
  const resumed = new IterativeSearch({ enabled: true, state: f.events.at(-1)!.data.state, checkpoint: f.checkpoint });
  await resumed.execute(f.tools, next()); f.reviewed();
  assert.equal(resumed.snapshot()!.trajectories[0]!.history.length, 2);
  const foreign = fixture(); foreign.run.id = "run-two";
  await assert.rejects(resumed.execute(foreign.tools, next()), /run_mismatch/);
  const pending = new IterativeSearch({ enabled: true, state: f.events[0]!.data.state, checkpoint: f.checkpoint });
  await assert.rejects(pending.execute(f.tools, next()), /pending_recovery/);
  const forged = createIterativeState(f.run);
  forged.trajectories = [{ name: "fake", strategy: "fake", path: ["source", "image-1"], stopped: false, history: [] }];
  await assert.rejects(new IterativeSearch({ enabled: true, state: forged, checkpoint: f.checkpoint }).execute(f.tools, next("fake")), /invalid_history_path/);
});

test("failed/uncertain generation is charged and concurrent execution is refused", async () => {
  const f = fixture(2);
  let release!: () => void;
  f.tools.generateImage = async () => { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("provider failure"); };
  const first = f.search.execute(f.tools, fresh());
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.search.execute(f.tools, fresh("other", "other")), /busy/);
  release();
  await assert.rejects(first, /provider failure/);
  assert.equal(f.search.snapshot()!.extra_generation_charges, 1);
  await assert.rejects(f.search.execute(f.tools, next()), /reserved_for_new_starts/);
  assert.equal(f.events.at(-1)!.data.phase, "failed");
});

test("checkpoint failure prevents generation and requires durable reload", async () => {
  const f = fixture();
  const search = new IterativeSearch({ enabled: true, checkpoint: async () => { throw new Error("disk failure"); } });
  await assert.rejects(search.execute(f.tools, fresh()), /disk failure/);
  await assert.rejects(search.execute(f.tools, fresh()), /reload_required/);
  assert.deepEqual(f.calls, []);
});

test("ambiguous core charge is refreshed and counted once, including persisted state", async () => {
  const f = fixture(2);
  let failed = false;
  const pool = f.tools.listImagePool;
  f.tools.listImagePool = async () => {
    if (failed) f.run.generation_count = 1;
    return pool();
  };
  f.tools.generateImage = async () => { failed = true; throw new Error("ambiguous provider error"); };
  await assert.rejects(f.search.execute(f.tools, fresh()), /ambiguous provider/);
  assert.equal(f.run.generation_count, 1);
  assert.equal(f.search.snapshot()!.extra_generation_charges, 0);
  assert.equal(f.events.at(-1)!.data.state.extra_generation_charges, 0);
  assert.equal(f.search.snapshot()!.pending, undefined);
});

test("preparation failures do not spend candidate budget", async () => {
  for (const method of ["selectParent", "selectReferences", "setPrompt"] as const) {
    const f = fixture();
    f.tools[method] = async () => { throw new Error("preparation failed"); };
    await assert.rejects(f.search.execute(f.tools, fresh()), /preparation failed/);
    assert.equal(f.run.generation_count, 0);
    assert.equal(f.search.snapshot()!.extra_generation_charges, 0);
    assert.equal(f.calls.includes("generate"), false);
    assert.equal(f.events.at(-1)!.data.state.extra_generation_charges, 0);
  }
});

test("failed accounting refresh retains pending reservation rather than guessing a refund", async () => {
  const f = fixture();
  f.tools.generateImage = async () => {
    f.tools.listImagePool = async () => { throw new Error("refresh failed"); };
    throw new Error("provider failed");
  };
  await assert.rejects(f.search.execute(f.tools, fresh()), /refresh failed/);
  assert.ok(f.search.snapshot()!.pending);
  assert.equal(f.search.snapshot()!.extra_generation_charges, 1);
  assert.equal(f.events.at(-1)!.data.phase, "reserved");
});

test("ADOPT attaches an external SVG-shaped draft without a call or charge and CONTINUE uses it", async () => {
  const f = fixture();
  await f.search.execute(f.tools, fresh()); f.reviewed();
  // The shared pipeline has already recorded/charged this external edit as a normal draft.
  await f.tools.generateImage(); f.reviewed();
  const beforeCalls = [...f.calls];
  const adopted = await f.search.execute(f.tools, { action: "ADOPT", trajectory: "layout", draft_id: "draft-2", rationale: "Continue from the SVG edit." });
  assert.deepEqual(f.calls, beforeCalls);
  assert.equal(f.run.generation_count, 2);
  assert.equal(adopted.state.extra_generation_charges, 0);
  assert.deepEqual(adopted.state.trajectories[0]!.path, ["source", "image-2"]);
  assert.equal(adopted.state.trajectories[0]!.history.at(-1)!.outcome, "adopted");
  const resumed = new IterativeSearch({ enabled: true, checkpoint: f.checkpoint, state: adopted.state });
  await resumed.execute(f.tools, next());
  assert.equal(f.run.drafts.at(-1)!.parent_artifact_id, "image-2");
  assert.equal(f.run.generation_count, 3);
});

test("ADOPT rejects hidden, invalid, unreviewed, disconnected and already tracked candidates", async () => {
  for (const [change, expected] of [
    [(f: ReturnType<typeof fixture>) => { f.pool.pop(); }, /not_main_visible/],
    [(f: ReturnType<typeof fixture>) => { f.run.drafts[1]!.status = "ambiguous"; }, /not_selectable/],
    [(f: ReturnType<typeof fixture>) => { f.run.drafts[1]!.viewed_at = undefined; }, /view_and_evaluation/],
    [(f: ReturnType<typeof fixture>) => { f.run.drafts[1]!.parent_artifact_id = "foreign-image"; }, /path_parent/],
    [(f: ReturnType<typeof fixture>) => { f.run.drafts[1]!.generation_input.reference_artifact_ids = ["hidden-target"]; }, /not_main_visible/],
  ] as const) {
    const f = fixture();
    await f.search.execute(f.tools, fresh()); f.reviewed();
    await f.tools.generateImage(); f.reviewed(); change(f);
    const before = f.search.snapshot();
    await assert.rejects(f.search.execute(f.tools, { action: "ADOPT", trajectory: "layout", draft_id: "draft-2", rationale: "Attach edit." }), expected);
    assert.deepEqual(f.search.snapshot(), before);
  }
  const f = fixture();
  await f.search.execute(f.tools, fresh()); f.reviewed();
  await assert.rejects(f.search.execute(f.tools, { action: "ADOPT", trajectory: "layout", draft_id: "draft-1", rationale: "Duplicate." }), /already_tracked/);
});

test("ADOPT cannot replenish an exhausted shared candidate budget", async () => {
  const f = fixture(2);
  await f.search.execute(f.tools, fresh()); f.reviewed();
  await f.tools.generateImage(); f.reviewed();
  await f.search.execute(f.tools, { action: "ADOPT", trajectory: "layout", draft_id: "draft-2", rationale: "Record final external edit." });
  await assert.rejects(f.search.execute(f.tools, next()), /generation_budget_exhausted/);
  assert.equal(f.run.generation_count, 2);
});

test("STOP search remains available after all individual trajectories have stopped", async () => {
  const f = fixture(1);
  await f.search.execute(f.tools, fresh());
  await f.search.execute(f.tools, { action: "STOP", trajectory: "layout", rationale: "Branch complete." });
  await f.search.execute(f.tools, { action: "STOP", trajectory: "layout", scope: "search", rationale: "Search complete." });
  assert.equal(f.calls.filter((item) => item === "stop").length, 1);
  assert.equal(f.run.generation_count, 1);
});

test("real MCP string/object actions reach the broker and runner; complete plans persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-iterative-"));
  try {
    const store = new FileStateStore(directory);
    const artifacts = new ArtifactStore(directory);
    const source = await artifacts.put({ bytes: await sharp({ create: { width: 64, height: 48, channels: 3, background: "#5080a0" } }).png().toBuffer(), mimeType: "image/png", originalName: "source.png" });
    const task = taskManifestSchema.parse({ schema_version: 2, id: "task-integration", title: "Branches", user_brief: "Change only the background.",
      source_artifact_id: source.id, references: [], preservation_contract: { color: "allow_change", detail: "preserve", composition: "preserve" },
      has_hidden_evaluation: false, created_at: at });
    await store.saveTask(task);
    let count = 0;
    class BranchAgent extends FakeAgentProvider {
      override async runRound(context: Parameters<FakeAgentProvider["runRound"]>[0], tools: AgentToolbox) {
        const broker = new AgentToolBroker();
        const unregister = broker.register("offline-test", tools, context);
        const server = createServer(async (req, res) => {
          try {
            assert.equal(req.headers["x-avo-tool-token"], "offline-test");
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const result = await broker.invoke("offline-test", req.url!.split("/").at(-1)!, JSON.parse(Buffer.concat(chunks).toString()));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as { port: number };
        const root = fileURLToPath(new URL("../../..", import.meta.url));
        const client = new Client({ name: "iterative-wire-test", version: "1" });
        try {
        await client.connect(new StdioClientTransport({ command: join(root, "node_modules/.bin/tsx"),
          args: [join(root, "apps/api/src/mcp-server.ts")], stderr: "pipe",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AVO_INTERNAL_API: `http://127.0.0.1:${address.port}`,
            AVO_TOOL_TOKEN: "offline-test", AVO_EXPERIMENTAL_FEATURES: JSON.stringify({ iterative_search: true }) } }));
        const invalid = await client.callTool({ name: "avo_iterative_action", arguments: { action: JSON.stringify({ ...fresh(), extra: true }) } });
        assert.equal(invalid.isError, true);
        assert.equal(tools.getRunSnapshot().generation_count, 0);
        for (const action of [fresh(), { ...next(), prompt: fresh().prompt }, { ...next(), action: "BACKTRACK", base_artifact_id: source.id }, fresh("color", "color-first")]) {
          const refId = tools.getRunSnapshot().drafts[0]?.artifact_id;
          const input = count === 3 ? { ...action, reference_artifact_ids: [refId],
            reference_usage: [{ artifact_id: refId, purpose: "composition", rationale: "Use layout only." }] } : action;
          const response = await client.callTool({ name: "avo_iterative_action", arguments: { action: count % 2 ? input : JSON.stringify(input) } });
          assert.ok(!response.isError, JSON.stringify(response));
          const result = JSON.parse((response.content as { text: string }[])[0]!.text);
          assert.ok(result.artifact_id && result.draft_id);
          await tools.viewImage(result.artifact_id);
          await tools.evaluateDraft(result.draft_id);
          count++;
        }
        const first = tools.getRunSnapshot().drafts[0]!;
        const second = tools.getRunSnapshot().drafts[1]!;
        const fourth = tools.getRunSnapshot().drafts[3]!;
        assert.equal(fourth.generation_input.reference_usage?.[0]?.purpose, "composition");
        const hypothesis = { id: "clean-source", statement: "One observed pair; stochastic variation remains possible.",
          status: "supported" as const, evidence_refs: [first.id, second.id] };
        await assert.rejects(tools.upsertHypothesis(hypothesis), /structured_trial_claim/);
        await assert.rejects(tools.upsertHypothesis({ ...hypothesis, status: "refuted",
          trial_claim: { kind: "clean_source_failed", draft_ids: [fourth.id] } }), /not_clean_source/);
        await tools.upsertHypothesis({ ...hypothesis, trial_claim: { kind: "base_effect", draft_ids: [first.id, second.id] },
          alternative_explanations: ["Generation randomness; one pair is not a universal result."] });
        assert.equal((await store.getRun(context.run.id)).hypotheses[0]?.trial_claim?.kind, "base_effect");
        const usage = [{ artifact_id: first.artifact_id, purpose: "composition", rationale: "Layout only; do not copy road texture." }];
        const plan = await client.callTool({ name: "avo_set_edit_plan", arguments: {
          base_artifact_id: source.id, prompt: first.prompt, reference_artifact_ids: [first.artifact_id], reference_usage: usage,
        } });
        assert.ok(!plan.isError, JSON.stringify(plan));
        assert.equal(tools.getPrompt(), first.prompt);
        assert.deepEqual((await store.getRun(context.run.id)).selected_generation_input?.reference_usage, usage);
        const clean = await client.callTool({ name: "avo_set_edit_plan", arguments: {
          base_artifact_id: source.id, prompt: first.prompt, reference_artifact_ids: "[]", reference_usage: [],
        } });
        assert.ok(!clean.isError, JSON.stringify(clean));
        assert.deepEqual((await store.getRun(context.run.id)).selected_generation_input?.reference_artifact_ids, []);
        assert.equal(tools.getPrompt(), first.prompt);
        assert.equal(tools.getRunSnapshot().generation_count, 4);
        const evidence = await client.callTool({ name: "avo_get_trial_evidence", arguments: { draft_ids: [first.id] } });
        assert.ok(!evidence.isError, JSON.stringify(evidence));
        const ledger = JSON.parse((evidence.content as { text: string }[])[0]!.text);
        assert.equal(ledger.trials[0].clean_source_generation, true);
        assert.equal(ledger.trials[0].replay.prompt, first.prompt);
        const stopped = await client.callTool({ name: "avo_iterative_action", arguments: { action: { action: "STOP", trajectory: "color", scope: "search", rationale: "Finished testing branches." } } });
        assert.ok(!stopped.isError, JSON.stringify(stopped));
        } finally {
          await client.close();
          unregister();
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      }
    }
    const runner = new AvoRunner(store, artifacts, new BranchAgent(), new FakeImageProvider(), new FakeVerifierProvider(1));
    const run = await runner.createRun(task.id, { mode: "avo", max_generations: 6, supervisor_enabled: false,
      experimental_features: { iterative_search: true, svg_editing: false, copilot_routing: false } });
    const done = await runner.start(run.id);
    assert.equal(count, 4, done.terminal_reason);
    assert.equal(done.generation_count, 4);
    assert.equal(done.drafts[3]!.parent_artifact_id, source.id);
    const events = await store.listRunEvents(run.id);
    assert.equal(events.filter((event) => event.type === "experiment.iterative.updated").length, 9);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
