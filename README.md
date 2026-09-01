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

AVO reads the installed Codex CLI version, generates matching app-server protocol schemas, and builds a project-local model catalog from the selected model. The global Codex model cache is never changed. App-server runs with a read-only sandbox and disables shell, browser, plugins, memories, multi-agent, skills discovery, and built-in image generation. Only the `avo_*` MCP tools are exposed to the Main Agent.

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

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The browser test uses the fake stack. A Codex/MCP-only smoke that keeps image generation and Qwen fake is available with:

```bash
pnpm --filter @avo/api exec tsx scripts/codex-mcp-smoke.ts
```

## Attribution

The lineage, trajectory, correctness-gate, and supervisor concepts are informed by the Apache-2.0 project [gatordevin/avo](https://github.com/gatordevin/avo) and the AVO paper. This repository is an independent TypeScript implementation and does not vendor the upstream Python package.
