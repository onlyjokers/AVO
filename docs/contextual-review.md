# Contextual review and model routing

## Providers

The task page selects Main Agent, Verifier and Supervisor independently. A new
Run freezes `role_profiles` and model names; changing startup defaults does not
reroute an existing Run. Credentials never enter the Run or browser payload.
Image generation keeps its separate provider and key.
All three roles may use Astra, all three may use Qwen, or they may be mixed.
The browser remembers the last selection across reloads and task pages. Startup
defaults apply only when no valid saved choice exists. A provider error is reported
for the selected provider; it does not silently switch a role to Qwen.

`AVO_MAIN_PROVIDER`, `AVO_VERIFIER_PROVIDER`, `AVO_SUPERVISOR_PROVIDER` accept
`qwen` or `78code`. The latter defaults to `https://www.78code.cc/v1` and
`gpt-6-astra`. Configure `AVO_78CODE_API_KEY` in ignored `.env.local` (mode 0600).
An optional `AVO_78CODE_PROXY_URL` applies only to 78code. Native Astra requests
bypass Qwen namespace/SSE rewriting and DashScope headers. The evaluator uses
bounded local replay rather than assuming provider response storage is available.

The workspace pins `@openai/codex` 0.153.4. `AVO_CODEX_BIN=codex` resolves to this
workspace binary, not the globally installed CLI. A custom explicit binary path
is still respected. Tool approvals apply only to the validated AVO allowlist;
shell, arbitrary MCP servers and file edits remain unavailable to Main Agent.

## Review state

Verifier and Supervisor retain separate, per-Run/per-model review histories in
`data/sealed/review-context`. Four bounded exchanges contain text plus references
to immutable images. Images are explicitly reloaded, not inferred from a text
summary. No hidden images or private histories are injected into Main Agent.
The Verifier receives the actual generation parent and earlier reviewed images.
Supervisor and historical comparison context use cached 1024px analysis previews;
original Artifacts and the current candidate's verification image remain unchanged.
Critical acceptance proposals also receive an independent reverse-order review;
correctness or blocker disagreements trigger adjudication even if preference agrees.

This is application-managed persistent context, not a promise that the upstream
provider retains an unlimited conversation. It survives an API restart. Historical
acceptance remains auditable and fallible. Changing the evaluation axes or target
interpretation triggers incumbent review. The latest public-safe assessment is
stored on the node without rewriting its original Commit. Reusing a node with a
failed/unclear review requires an explicit Agent rationale.

Media visibility does not determine importance. Verifier must explain the human
anchor behind semantic gates and target deltas; source difference measurements
are evidence, not preservation mandates. Supervisor can request historical-node
review and must distinguish branch-local evidence, tested alternatives and a
cost-based decision to stop. Parent-selection events record whether its requested
parent/branch change was followed. No fixed image-edit depth limit is imposed.

## Long image operations

One logical generation performs up to five 120-second provider attempts without
returning intermediate failures to Main Agent. Local HTTP uses an explicit Node
request instead of fetch's independent 300-second headers timer. MCP timeout is
derived from the entire retry window and Step timeout, plus cleanup reserves.
User stop/hard cutoff still preserve completed results without allowing new work.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`.
The following probes spend real text/vision tokens, but do not purchase image
generations or mutate the original Run:

```sh
AVO_MAIN_PROVIDER=78code pnpm --filter @avo/api exec tsx scripts/codex-mcp-smoke.ts
pnpm --filter @avo/api exec tsx scripts/probe-78code.ts <existing-run-id> --supervisor
```

The first uses a real Codex/MCP Agent with fake image/evaluation providers. The
second reassesses real historical images and optionally checks Supervisor output.
Keep protocol success separate from image-quality improvement in a fresh live Run.
