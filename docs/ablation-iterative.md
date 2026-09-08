# Iterative Search Ablation

## Provenance and scope

Primary sources checked on 2026-09-07:

- [Jaiswal et al., Iterative Refinement Improves Compositional Image Generation, arXiv:2601.15286v1, Section 3](https://arxiv.org/html/2601.15286v1#S3): iterative refinement allocates a budget across rounds and parallel streams, with continue, backtrack, restart and stop actions.
- [Official Iterative-Image-Gen repository](https://github.com/shantanuj/Iterative-Image-Gen): the released loop combines generation, VLM feedback and verifier-based candidate selection.
- [Official image inference README](https://github.com/shantanuj/Iterative-Image-Gen/tree/main/image_gen/inference_time_iterative_refinement): the implementation names the restart action `FRESH_START` and exposes all four actions.

This is an inspired AVO adaptation, **not an exact reproduction**. Main remains the sole action/prompt author; no new AI role is created. Existing evaluation, submission and finalization retain authority. No score-max candidate selection is implemented here. FRESH_START edits the original Source, not an unconditioned text-to-image canvas. Independent named branches run **sequentially**, not as parallel provider sampling. Main owns orchestration across the five experiment arms; this module does not launch arms or paid experiments.

## Delivered interface

Only three new files belong to this implementation:

- `apps/api/src/experiment-iterative.ts`
- `apps/api/test/experiment-iterative.test.ts`
- `docs/ablation-iterative.md`

Exports:

- `iterativeActionSchema` / `IterativeAction`: strict Zod discriminated union for one MCP tool, proposed name `avo_iterative_action`.
- `IterativeSearch({ enabled, checkpoint, state?, plannedStarts?, now? })`: run-owned executor; `execute(tools: AgentToolbox, input: unknown)` returns action, resulting state, and generated artifact/draft IDs when applicable. `snapshot()` returns a defensive copy.
- `iterativeStateSchema` / `IterativeState`: versioned, JSON-serializable state, explicitly supplied rather than coupled to core schema changes.
- `createIterativeState(run, plannedStarts = 2)`: clamps the requested breadth to currently remaining candidate budget; accepts 1-24 planned starts.
- `iterativeContext(enabled, run, state?, mainImagePool?)`: public prompt/context helper. Returns an empty string when disabled; requires the Main image pool when state is supplied and validates trajectory IDs before exposing them. Never serializes raw RunSnapshot, evaluator reports, image paths or sealed task data.
- `IterativeCheckpoint`: typed persistence callback payload, with reservation, generation, failure and stop phases.

## Actions

Every generating action requires `trajectory`, an explicit Main-written `prompt`, and `rationale`. Optional `reference_artifact_ids` defaults to an empty list rather than inheriting stale references. Optional `override_rationale` is forwarded to the existing parent-selection guard, never invented automatically.

| Action | Additional fields | Actual behavior |
| --- | --- | --- |
| FRESH_START | `strategy` | Allocate a unique named branch rooted at Source and generate once. Reject duplicate names and normalized duplicate strategy descriptions. |
| CONTINUE | none | Select the named branch's current head and generate once. |
| BACKTRACK | `base_artifact_id` | Require an ancestor on that branch's active path, select it, and generate once. Truncate only the active path; retain discarded generations in append-only history. |
| ADOPT | `draft_id` | Attach an already viewed/evaluated public candidate whose parent is on the trajectory. This AVO/SVG integration extension makes no image call and spends no extra candidate budget. |
| STOP | optional `scope: "trajectory" \| "search"` | Stop the named branch, or stop all branches and call existing `signalStop()`. Does not generate, submit or choose a final image. |

Paths are ordered artifact IDs, not filesystem paths. History records parent/result/draft linkage, prompt, references, rationale and outcome. A historical image outside the active path, another branch's image, a reference-only image, or an ambiguous/preverify-rejected draft cannot be used as a backtrack base. Source is resolved from `tools.listImagePool()` and checked against the run seed. References must also be in that Main-visible pool. The module never receives a sealed evaluator store or hidden target path.

Naming and different strategy text provide **operational diversification**, not a semantic proof that two prompts differ meaningfully. Main chooses the strategies. All branches remain available until explicitly stopped; no ranking removes a lower-scoring branch.

## Minimal parent integration

Parent owns `run.config.experimental_features = { svg_editing, iterative_search, copilot_routing }`, all default false. Do not advertise/register the new tool, append its prompt context, create state, or write checkpoints for disabled runs. The executor rejects disabled calls before even reading the toolbox.

Parent has added `AgentToolbox.recordExperimentState(kind, state, detail?)`; use it as the checkpoint adapter. No additional core schema change is requested by this module. After the parent's hook is available, the integration can follow this shape inside the existing serialized broker invocation:

```ts
const enabled = run.config.experimental_features?.iterative_search === true;
const persisted = run.experimental_state?.iterative;
const search = new IterativeSearch({
  enabled,
  state: persisted === undefined ? undefined : iterativeStateSchema.parse(persisted),
  checkpoint: ({ data }) => tools.recordExperimentState(
    "iterative", data.state, { phase: data.phase },
  ),
});
const result = await search.execute(tools, args);
const pool = await tools.listImagePool();
return {
  ...result,
  context: iterativeContext(enabled, tools.getRunSnapshot(), result.state, pool),
};
```

Resolve `run` from the current run-owned state, not an old AgentRoundContext. Persist **every checkpoint**, not just the final returned state: the reservation must be durable before a provider call. The new hook persists `experimental_state.iterative` plus `experiment.iterative.updated`; standalone tests use an ordinary run-owned event with the same payload instead. Do not store trajectory facts in WorkingMemory prose or mutate hypotheses.

Keep one active executor per run or reconstruct under the existing serialized broker queue from its latest durable state. The instance refuses simultaneous calls, but separate instances cannot synchronize each other. Preserve existing broker tool-call accounting, decision-required guard, deadline/closing guard and queue. Treat this tool as generation-capable, so it must not be broadly added to decision-only allowlists just because it can also STOP. Existing stop/finalization remains available during decision-only periods.

After a generation, Main must use existing `avo_view_image` and `avo_evaluate_draft`, then normal submit/decline/abandon tools. The executor deliberately does not call the evaluator internally or force acceptance. Existing `generateImage` review and duplicate-generation guards remain active. A FRESH_START does not open a new core step or reset a round's budget.

## Budget and failure semantics

- Effective remaining budget is `max_generations - generation_count - state.extra_generation_charges`. Every new candidate uses normal `generateImage`; successful candidates are counted by core, including the parent's other candidate-producing mechanisms such as SVG. This is a shared candidate budget, not a free allowance per trajectory.
- Each unstarted planned branch reserves one remaining call. CONTINUE/BACKTRACK cannot spend those reservations. Main may choose a single-start setup with `plannedStarts: 1` or stop search early. Unused budget is not force-spent.
- Run, round, wall-time, token, pending-decision and soft/hard-deadline guards are checked before mutation; generation guards are checked again before calling the provider. Parent remains responsible for authoritative broker accounting and concurrent state changes.
- A reservation adds an extra charge before tool mutations. Successful generation transfers that charge to core's generation count. Preparation failures refund it. Generation failures refresh core state: an already charged ambiguous outcome is not charged twice; otherwise the conservative reservation remains. The module never retries automatically. The existing image provider may make its own transport retries.
- The integrated iterative arms do not advertise ordinary `avo_generate_image`; all image-model calls use the trajectory action tool. SVG finalization honors outstanding extra charges. Working SVG edits stay autonomous, and `ADOPT` connects their evaluated candidates to a path without charging again. Do not apply these restrictions to disabled runs.
- Report successful candidate count, actual image-provider calls/attempts and actual cost separately using existing provider/generation events. Trajectory history counts logical actions, not transport attempts. Do not claim an experimental gain from these tests.
- A crash with a durable `pending` reservation refuses replay (`iterative_pending_recovery_required`). Parent must reconcile against run-owned draft/generation events before resuming, or end that run. Do not clear pending and retry blindly. A persistence error poisons the live instance and requires durable reload; a generated draft remains owned by the normal runner even if its trailing checkpoint failed.
- Preparation is not a transaction: parent/reference/prompt mutations can already be persisted when a later stage fails. The failed history entry records the intended action, not successful execution. No unrelated run state is rolled back.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm --filter @avo/api typecheck
pnpm --filter @avo/api exec tsx --test test/experiment-iterative.test.ts
```

Focused tests cover actual action dispatch and parent paths, branch history, explicit stopping, disabled no-op context, hidden references/context leakage, invalid historical bases, distinct starts, review-before-generation, run/round/time/token budgets, persistence/reload, cross-run isolation, failed-call accounting and simultaneous-call rejection. A real `AvoRunner` integration with fake image/verifier providers executes four sequential generations and verifies durable events. These are local engineering checks, not paid quality experiments or production-run evidence.
