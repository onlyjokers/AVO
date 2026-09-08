# Copilot Routing Ablation

## Source and Adaptation

Reviewed 2026-09-07: [T2I-Copilot paper, sections 3.1-3.3](https://arxiv.org/html/2507.20536v1) and [official main.py](https://github.com/SHI-Labs/T2I-Copilot/blob/master/main.py).

The paper uses three sequential agents: Input Interpreter, Generation Engine, and Quality Evaluator. It structures intent into a report, chooses a model using intent and capabilities, prepares targeted masks, and iterates using evaluation feedback. Its implementation stores prompt analysis separately from per-regeneration model, input, mask, reasoning and outcome fields in `T2IConfig`.

This is an adaptation, not a reproduction. Existing Main supplies typed interpretations, ambiguities, deltas and explicit operation routes. There is no added AI role or mandatory stage pipeline. The experimental roles remain Astra, configured by the parent integration. SVG-versus-generator routing and immutable public-brief binding are AVO additions. This module does not import their model stack, creative prompt autocomplete, thresholds, latest-image final selection, or a second judge. Verifier remains the existing judge; Controller retains permissions, deadlines and budgets. No benchmark improvement is claimed.

## Public API

`apps/api/src/experiment-copilot.ts` exports:

- `CopilotEnvironment`: server-owned public brief, public artifact inventory, live capabilities, run ID and feature flags.
- `copilotPlanInputSchema`, `copilotOperationSchema`: strict Zod schemas for Main's plan tool and normalized edit descriptions.
- `CopilotState`, `copilotStateSchema`: JSON-persistable versioned revisions and runtime outcomes.
- `updateCopilotPlan(state, input, environment)`: validates a complete plan revision using optimistic `expected_revision` (0 initially). Returns new state; never edits the task, prompt, preservation, checklist, run config or caller-owned state.
- `copilotContext(state, environment)`: public context, capabilities, active plan and outcomes; returns `undefined` when disabled.
- `assertCopilotEdit(state, actualOperation, environment)`: checks current plan and live permissions immediately before execution. Returns normalized operation, or `undefined` when disabled.
- `recordCopilotOutcome(state, outcome, environment)`: immutable, idempotent runtime result append. A success requires an existing public image artifact and normal draft ID; it is not an acceptance or score.

An operation contains Main's intent, `kind`, selected `route` and adapter capability ID, public base/reference IDs, typed parameters, normalized region or SVG elements, mask plan and rationale. Semantic content generation requires `image_generator`; deterministic opacity/text/color may select SVG or a genuinely supporting image capability. Structured SVG commands require the server's command allowlist. A proposed mask may be recorded but cannot execute until Main revises it to a materialized public mask. Unsupported scopes/masks are rejected, not silently ignored.

## Minimal Parent Hooks

1. Parent owns run schemas: default all `experimental_features` to false. Register `avo_update_copilot_plan` with `copilotPlanInputSchema` only when `copilot_routing` is true; do not expose runtime outcome recording as a Main tool. Persist returned state through `await tools.recordExperimentState("copilot", nextState, { revision: nextState.revisions.length })`, which owns `run.experimental_state.copilot` and `experiment.copilot.updated` events, inside the existing invocation queue. Parse persisted state with `copilotStateSchema` when loading it. No isolated contracts/schema edit is necessary.
2. Build `CopilotEnvironment.public_brief` explicitly from public task text, exact preservation strings and public checklist items. Never spread a raw task/run/Verifier request into it. Populate assets from permission-checked public image pool plus wrapper-owned public SVG documents and materialized masks. Never include hidden targets, sealed references, filesystem paths or private feedback. Context contains no automatic inference from private data.
3. Supply `copilotContext` in Main's initial round input and `avo_get_state`, before edits. Main can create/update plans, inspect, execute another planned operation, evaluate, revise, or stop at any point. Interpretation is recorded as a hypothesis, not substituted into the user brief or judging contract. Public-brief changes invalidate old state; explicitly archive/reinitialize instead of silently rebasing it.
4. At generation and SVG mutation boundaries, use the selected operation ID to resolve the current plan, but reconstruct `actualOperation` from actual resolved base/references/scope/mask/parameters and check with `assertCopilotEdit`. Never validate a copy of the plan and then execute unrelated tool arguments. For image generation, compare the real selected input and `getPrompt()` to the declared operation. If the current provider has no mask input (current `ImageProvider.generate` does not), advertise only `masks: ["none"]`; do not claim mask support based on prompt wording. Full-image guidance does not enforce pixel preservation.
5. Parent's wrapped svg-mcp owns create/import, structured operations, render, artifact registration and the normal evaluation candidate path. It validates command arguments, all nested asset references, SVG element ownership, URLs/paths and XML safety. This module validates route/command membership, not arbitrary SVG payload safety. Advertise only implemented capabilities, scopes and commands; recheck at execution. Public image import does not imply automatic segmentation/vectorization of raster objects. Elements must already exist in the public SVG inventory. Read-only inspect/render calls need not force new plan stages; mutation calls must match a planned operation.
6. Capture plan revision, operation ID and stable execution ID before awaiting an edit. Append runtime success/failure with `recordCopilotOutcome` after registering a rendered/generated image as a normal draft and refreshing public inventory. Verify draft/artifact correspondence in core (this standalone module has no draft store). Record sanitized errors, not raw provider paths/secrets. Persist failures too; use the captured revision even if a later plan exists. Evaluation/submit/abandon continue unchanged. Interrupted executions require normal parent recovery, not fabricated outcomes.

`svg_editing` and `copilot_routing` are independent: Copilot can plan generator-only work, and SVG may work without Copilot. `iterative_search` is not read by this module. For a disabled run, do not register the tool, inject context, allocate state or change edit arguments. Keep existing decision-required/deadline/budget guards in front of experimental edits; do not let plan tools bypass finalization.

The wrapper's actual capabilities can include public-image document creation, add_image by artifact ID, text, opacity, shapes, gradients, masks, color transfer and blur. Map general operations to `svg_structured` with the actual allowlisted command names. A semantic mountain cutout is not an upstream automated feature: Main must author geometry or supply public alpha. A shape/mask command is deterministic manipulation of that supplied geometry, not proof that it matches a mountain. Preserve the identical evaluator rubric across treatments and charge finalized SVG candidates through the normal budget/evaluation path.

## Verification and Limits

Focused tests cover semantic versus deterministic routes, mask readiness, live capability revocation, missing/hidden asset IDs, unsupported commands, strict immutable revisions, unchanged baseline, outcome idempotency and public context projection. They make no AI/provider calls. In a dependency-installed checkout run `pnpm --filter @avo/api exec tsx --test test/experiment-copilot.test.ts`.

No dependency/package changes, paid launches, credentials access or shared hooks are included in this worktree. Parent must test real MCP registration, persisted reload, provider argument binding, SVG rendering and ordinary Verifier submission before claiming end-to-end integration. Natural-language intent alignment remains Main/Verifier work: quote grounding and immutable brief hashing prevent silent contract mutation, not semantic dishonesty in free text. Equal model/budget baselines remain required for ablation conclusions.
