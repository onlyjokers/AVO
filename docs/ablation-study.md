# Five-arm AVO study

## Scope

The baseline is the actual dirty workspace as of 2026-09-07, captured using an alternate Git index as `codex/ablation-baseline-20260907` (`019ce6de87868949abd2a08498be9e959110f3ce`). The user's existing index and worktree were not reset or committed onto main. Independent implementations live in the `AVO-iterative` and `AVO-copilot` worktrees. Their modules are integrated into main behind optional per-run flags.

| Arm | SVG | Iterative-inspired search | Copilot-inspired routing |
| --- | --- | --- | --- |
| 0 | off | off | off |
| 1 | on | off | off |
| 2 | on | on | off |
| 3 | on | off | on |
| 4 | on | on | on |

These are adaptations, not paper reproductions. The iterative arm uses two budget-aware, independent named starting strategies with serial image-model execution because AVO requires every candidate to be viewed and evaluated before another. It exposes continue/backtrack/fresh-start/stop, plus ADOPT to attach already evaluated SVG edits. The Copilot arm records Main's interpretation, uncertainty, target delta and executable route rather than adding another AI role. No new policy is imposed on Verifier. See the two component documents for sources and limitations.

## SVG dependency

Upstream: <https://github.com/georgeharker/svg-mcp>, GPL-2.0-or-later, pinned at `0749c84153431f36803ec12034d64f390e2bca91` (0.7.1). It runs as an independent stdio MCP process; no Photoshop, GIMP, Inkscape application or browser renderer is launched. The default rendering backend is forced to in-process `resvg-py`.

The upstream unbounded FastMCP dependency currently resolves to an incompatible 4.x API. `apps/api/svg-mcp-requirements.txt` pins the verified dependency environment, including FastMCP 3.4.2 and MCP 1.28.1. Install in `tmp/svg-mcp-venv` with `pnpm avo:svg:setup`. On macOS, source-built inkex dependencies may require `pkgconf`, `cairo` and `gobject-introspection`; these are libraries, not an editor installation. Python 3.13 was used for the live gate. A package mirror may be configured through uv when direct PyPI downloads fail.

AVO exposes five bounded tools, with discovery of a restricted upstream operation inventory. It does not expose raw SVG/file import, arbitrary script execution, remote URLs, host filesystem export or hidden image paths. Public images are embedded by Controller from the allowed run image pool. SVG documents and immutable revisions live under each Run's `svg-documents/` directory. They survive an Attempt boundary; opening an SVG candidate restores its layers.

The editor supports compositing, text, geometry, opacity, masks, gradients and RGB transfer. It is not a neural cutout model or a generative geometry editor. Main must not claim an automatically segmented mountain mask exists. Original-size PNG candidate output uses the same normal Draft, view, comparative evaluation and commit pipeline. Renderer previews are capped at 1024px; formal artifacts are not reduced.

New working edits stop at the soft deadline. Finalizing an already edited document is permitted until the hard deadline so prepared work is not discarded by a new-generation guard. Candidate budget and pending-decision checks still apply. Failed upstream mutations reload the last saved SVG revision.

## Controls and accounting

- Task: existing `华为测试4`, `task-53069f06-411e-420a-98ba-cabba26726b9`, without rewriting its Brief, checklist, preservation contract or sealed reference.
- Main, Verifier and Supervisor: `78code / gpt-6-astra`; the existing image-generation model remains unchanged across all arms.
- Same role-specific reasoning efforts, image provider, retries, preview size, evaluator revision, candidate cap and wall-time cap.
- Defaults: 24 finalized candidates, 90 minutes per Run, 15/20 minute Attempt soft/hard deadlines, existing 64-call Attempt guard. A finalized SVG image and an image-provider candidate both spend one shared slot. Unchanged document revision finalization is idempotent.
- Raw provider calls/retries, SVG edit/preview calls, tokens, elapsed time, accepted versions and final choices are distinct measurements. Neither confidence nor accepted-version count is used as an image-quality score.
- Every arm has fresh Run-owned Memory, review context, SVG session and strategy state. No candidate history is copied between arms.
- The model/provider APIs do not give us a shared deterministic random seed; a single-task, single-replicate study is exploratory, not a statistically established effect.

Before starting, freeze an implementation Git snapshot and use its ref with the runner. Leave source files unchanged during the study. Both baseline-disabled tool inventory and prompt omission have tests; no experimental tool/extra prompt is advertised in arm 0.

## Running

```sh
pnpm avo:ablation --suite-id huawei4-ablation-20260907 --concurrency 5
# Inspect the generated manifest, then launch the explicitly paid live study:
pnpm avo:ablation --suite-id huawei4-ablation-20260907 --concurrency 5 --execute
pnpm avo:ablation:review --suite-id huawei4-ablation-20260907 --execute
```

The first command is plan-only. Live runs appear in the normal UI. The run script resumes monitoring an existing suite by recorded run IDs and does not blindly duplicate a timed-out create request. It does not automatically restart failed runs or switch models. `results.json`, final PNGs and `report.html` are saved under `data/ablations/<suite>/`.

The optional final review creates one new common evaluation frame and compares blinded final images in forward and reverse presentation order. It receives the same user intent/reference inputs but no treatment names, histories or per-run judgments. Review results do not feed back into any experimental Main. Order disagreement is reported, not forced into a ranking. An automated same-model review is not a substitute for human preference calibration.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
AVO_TEST_SVG_MCP_COMMAND="$PWD/tmp/svg-mcp-venv/bin/svg-mcp" pnpm --filter @avo/api exec tsx --test test/svg-editor.test.ts
AVO_E2E_API_PORT=4430 AVO_E2E_WEB_PORT=4431 AVO_E2E_DATA_DIR=./tmp/e2e-ablation-data pnpm test:e2e
git diff --check
```

The real SVG test launches upstream, checks actual rendered text pixels, writes a formal candidate, deduplicates repeated finalization, and runs ordinary evaluation. A separate live Main smoke uses Astra with fake image/verifier providers solely to validate tool connectivity; it is not one of the five quality experiments.
# Common Transport Repair (2026-09-07)

The second suite `huawei4-ablation-20260907-r2` was also stopped, after persistent 180-second Verifier request timeouts. It is retained as diagnostic evidence, not a completed quality study. At the user's request, the next suite uses `AVO_VERIFIER_REQUEST_TIMEOUT_MS=360000` uniformly across arms. This is a temporary per-HTTP-request deadline shared by transport retries and streamed response reads; it does not extend the full Run or Attempt budgets, nor guarantee finalization. The setting can be reduced again independently. Its value is included in the suite controls hash.

The first suite `huawei4-ablation-20260907` is invalid for quality comparison. It was stopped across all five arms after a common harness conflict: Astra's model-facing request exposes `functions.exec` and defers MCP tools, while the AVO instructions prohibited JavaScript and discovery. A local dummy-provider request capture reproduced this interface even with Code Mode feature switches disabled. No model inference was used for that capture.

The rerun applies the same transport repair to every arm, including baseline: permit only discovery and sequential forwarding of authorized AVO calls through the wrapper, preserve image content blocks, and provide argument schemas from the validated MCP inventory. This does not grant filesystem, network, image synthesis, or other tool capabilities. The algorithm flags and evaluator remain unchanged. Original first-suite events are preserved, with a separate `invalidation.json`; they must not be pooled with the rerun.
