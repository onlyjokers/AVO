# AVO Image Editing MVP

Standalone local experiment for comparing Codex-driven AVO image editing with one-shot and no-feedback best-of-N baselines.

## Local development

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The API binds to `127.0.0.1:4310` and the web app to `127.0.0.1:4311`. `AVO_PROVIDER_MODE=fake` is the safe default and never calls external models.

The fake stack runs the complete Controller, event store, HTTP/SSE API, Web UI, AVO loop, Supervisor, one-shot, and best-of-N paths without external cost.

## Live providers

Set the following server-only variables in `.env` before enabling live mode:

```bash
AVO_PROVIDER_MODE=live
AVO_RUN_LIVE_PROBES=true
OPENAI_API_KEY=...
QWEN_BASE_URL=...
QWEN_API_KEY=...
QWEN_MODEL=...
```

Live readiness performs an actual Codex turn, one GPT Image 2 edit, and Qwen checklist/verification calls. These probes can incur Provider usage. A run or benchmark cannot start or resume unless all probes pass.

One logical image-generation tool call may submit up to five Provider tasks. Each submission has a 120-second deadline and a distinct `client_task_id`; transient timeouts remain inside the Provider adapter, so the Main Agent receives only the first successful image or one aggregate error after all retries are exhausted. Retry attempts are retained in the Controller event log for cost and reliability auditing.

AVO reads the installed Codex CLI version, generates matching app-server protocol schemas, and builds a project-local model catalog from the selected model. The global Codex model cache is never changed. App-server runs with a read-only sandbox and disables shell, browser, plugins, memories, multi-agent, skills discovery, and built-in image generation. Only the `avo_*` MCP tools are exposed to the Main Agent.

Each AVO Agent Invocation starts a fresh, ephemeral Codex thread and one continuous `turn/start`. Inside that autonomous Variation Attempt the Agent may freely select parents, author prompts, generate, inspect, evaluate, revise, update memory, and generate again. The Controller does not impose plan/generate/review/decide phases and does not interrupt after individual MCP actions. Attempts, comparisons, hypotheses, and memory live in the event store rather than in an indefinitely growing chat context.

The internal Codex provider proxy forces sequential tool calls, low reasoning, bounded output, and DashScope session caching while forwarding Responses SSE incrementally. Tool inputs accept Qwen's schema-equivalent JSON-string encoding for arrays and nested working memory, but malformed values still fail closed. Agent image views use a read-only preview whose longest edge is 1024 pixels; Provider artifacts remain unchanged.

Each Invocation has a 15-minute soft deadline and a 20-minute hard deadline. After the soft deadline, or when the rolling P95 generation-plus-evaluation estimate no longer leaves a 60-second decision reserve, the Broker blocks new image generation but still allows evaluation, submission, and abandonment. The hard deadline records `runtime_cutoff`, carries measured drafts into the next Attempt, and never fails the whole Run by itself. The default Run has no raw-token hard stop; generation, wall-time, and Invocation budgets remain hard limits, and an explicitly configured token budget ends as `budget_exhausted` rather than a system failure.

A single Agentic Verifier derives a fixed `EvaluationFrameRevision` at the beginning of each Invocation, then compares every Candidate directly with the official incumbent under that frame. Deterministic validators are sealed evidence tools for the Verifier, not scores exposed to the Main Agent. Only a technically valid Candidate judged strictly `better` with a Commit recommendation creates the next official version `x(t+1)`; equivalent, worse, and uncertain results enter Search Archive only. Normal Run and SSE responses redact private axes and tool evidence; the local UI reads them through the dedicated evaluator-results route.

At an Attempt boundary, the Supervisor manages search strategy and may return `stop_search` after a measured convergence window. It never chooses the winning image. Budget or Supervisor termination runs a terminal Verifier over the official single Lineage and records `final_verifier_decision_id`; an explicit user stop keeps the last Verifier-confirmed incumbent without adding another model call.

## Data ownership

`data/runs/<run-id>/events.jsonl` is the authoritative run log. Snapshots are rebuildable caches. Binary artifacts are stored once under `data/blobs/sha256` and are never committed to Git.

Every event log rewrite and snapshot update uses a temporary file plus atomic rename. A process restart changes orphaned `queued`, `running`, or `stop_requested` runs to `interrupted`; the user can then resume explicitly without replaying completed generation or verification events.

## Task folder manifest

The web UI can import a folder whose root contains `task.json`:

```json
{
  "title": "Replace the flowers",
  "request": "Replace the bouquet while preserving the person and composition.",
  "source": "source.png",
  "references": [
    { "path": "references/flowers.png", "caption": "Target flower species" }
  ]
}
```

It can also import a benchmark root containing 1–10 task folders in one selection:

```text
benchmark/
  task-01/
    task.json
    source.png
    references/...
  task-02/
    task.json
    source.webp
```

Paths in each manifest are relative to that manifest's directory. Absolute paths and `..` traversal are rejected.

## Verification

完整的真实 Provider、单任务、AVO 闭环和三方法实验步骤见 [测试指南](docs/testing.md)。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The browser test uses the fake stack. A Codex/MCP-only smoke that keeps image generation and Qwen Verifier fake is available with:

```bash
set -a
source .env
set +a
pnpm --filter @avo/api test:codex
```

## Attribution

The lineage, trajectory, correctness-gate, and supervisor concepts are informed by the Apache-2.0 project [gatordevin/avo](https://github.com/gatordevin/avo) and the AVO paper. This repository is an independent TypeScript implementation and does not vendor the upstream Python package.
