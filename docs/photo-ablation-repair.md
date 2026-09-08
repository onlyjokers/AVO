# Photo ablation repair and degradation audit

Date: 2026-09-08 (Asia/Shanghai)

## Scope and preserved control

This repair applies to experimental variants 1-4 in the shared AVO implementation, not four separate Git worktrees. The new presets are:

| Arm | Deterministic photo controls | Independent trajectories | Copilot routing |
| --- | --- | --- | --- |
| 0, fresh matched control | no | no | no |
| 1 | yes | no | no |
| 2 | yes | yes | no |
| 3 | yes | no | yes |
| 4 | yes | yes | yes |

The historical baseline `019ce6de87868949abd2a08498be9e959110f3ce`, r3 implementation snapshot `07b30a8626c10d82837155ec959ee52c87c43338`, old run records and original image bytes are unchanged. No commit was made. The old SVG option remains for compatibility, but is disabled in all new photo presets.

Future comparisons need a NEW matched control with the same Qwen model and evaluator. Old Astra results cannot serve as an isolated estimate of the new strategy's effect. `run-ablation.ts` now records treatment and a hash of current implementation source files in addition to Git ancestry, because this checkout contains uncommitted integrations. Dry-run is still the default; no full paid ablation was started by this repair.

## Why repeated generation was not avoided

Evidence: `data/ablations/huawei4-ablation-20260907-r3/manifest.json`, `candidate-diagnostics.json`, and the corresponding five `data/runs/<id>/snapshot.json` files.

| Old arm | Candidates | Direct Source parents | Generated parents |
| --- | --- | --- | --- |
| 0 | 6 | 6 | 0 |
| 1 | 5 | 5 | 0 |
| 2 | 6 | 3 | 3 |
| 3 | 3 | 1 | 2 |
| 4 | 7 | 4 | 3 |

19 of 27 candidates were already generated directly from Source. Therefore the hypothesis "the model never discovered restarting from Source" is not supported by the logs. Source-rooting avoids accumulating edits from a generated parent but does not prevent the image model from inventing texture on its first edit.

All 27 generation requests had zero auxiliary references. This task has zero PUBLIC references; its guidance image is evaluator-only. Main cannot use that hidden image as a generation reference. It can revise prompts and reuse permitted historical candidates. This is an information boundary, not evidence that reference selection silently failed. Exposing a hidden guidance image to the generator would change the experiment and requires an explicit task-level decision.

Main's saved memory also shows awareness: arm 0 recorded prompt-only road repainting failures; arm 2 proposed deterministic foreground restoration; arm 4 proposed a localized deterministic route. The failure is partly converting an observed hypothesis into an executable, tested edit, not simply absence of reasoning.

Arm 3 is different: its feedback explicitly treated repeated road texture as inherited rather than a new candidate-only defect, and Main carried that interpretation into memory. Its final selection then returned Source. The final and last intermediate comparison used frame revision 6. That frame already marked photorealism and quality preservation as blockers; it did not authorize inherited synthetic texture. This is an assessment inconsistency, not merely frame drift.

## Why detectors did not establish realism

`packages/validators/src/index.ts` measured high-frequency, Sobel and Laplacian retention primarily as lower-bound detail-loss signals. More synthetic texture can increase all three. Banding and 8/16-pixel blockiness target different damage mechanisms and do not detect arbitrary generated repetitions. Aggregate color/structure metrics do not locate the earliest defective ancestor or distinguish real asphalt from invented relief patterns.

Main also received redacted verbal feedback rather than raw measurements. Its normal viewing tool used a 1024px WebP preview and suppressed repeated views in the same step; there was no focused lossless crop tool. It could notice geometry and color while missing fine texture.

Repairs:

- High-frequency/Laplacian growth are now explicit warning-only diagnostics, with their limitations attached to evidence. They are not new semantic hard gates.
- Verifier receives matched Source/Parent/A/B detail sheets and the same Source comparison at final selection. Fixed sampled regions are not exhaustive and are not object-aligned after composition changes.
- Main has a controlled PNG crop tool, and recent candidate input provenance includes actual base, public references and reproducible photo recipes.
- Instructions ask Main to test alternative clean bases, revised prompts/references and deterministic tonal edits from evidence. There is no hard-coded edit-depth limit or false guarantee that Source regeneration is safe.

## Evaluation consistency repair

New comparisons must separately provide relative preference, current delivery quality, and unresolved defects with origin, region, severity and frame-axis references for BOTH candidate and incumbent. Historical records remain readable without inventing these assessments.

An inherited defect is still an outstanding defect. Any defect attached to a blocker axis must prevent delivery acceptance and correctness pass, even if the model calls the defect itself "major" or "minor". Candidate axis pass cannot contradict its defect ledger. Contradictory output receives one schema-repair opportunity, then fails closed. A consistency-repair reply cannot erase an already reported blocker to regain acceptable status; a separate evidence-based review is needed for reassessment. Better-but-defective candidates remain in Archive for possible repair rather than becoming official versions.

Final selection uses the same delivery interpretation and receives previous quality assessments. Reversals must explain the specific missed evidence or changed judgment. This improves auditability; it cannot guarantee a vision model notices every defect or never changes its judgment.

## Qwen 3.8 Max evidence

The requested model is exactly `qwen3.8-max`, using the existing DashScope Responses endpoint. The provided [model API reference](https://www.qianwenai.com/models/qwen3.8-max#api-reference) and [function-calling documentation](https://platform.qianwenai.com/docs/developer-guides/tool-calling/function-calling) were checked. No credential was sent to a new host.

- A real image-plus-function-call probe returned HTTP 200, model `qwen3.8-max`, and the correct red-color result in 2104ms.
- The production Verifier capability probe (checklist creation plus multi-image structured verification) also passed with Max in 46101ms.
- All four photo variants completed real Qwen/Codex/MCP tool loops: select base, preview, finalize, view, evaluate, submit. Each produced exactly one photo candidate. These tests used fake image generation and a fake evaluator; they establish tool integration, NOT output quality or model superiority.
- A real multi-image re-review of old arm 3's last accepted candidate took 289339ms and consumed 89881 reported total tokens across its comparison workflow. It identified inherited synthetic road texture, but still incorrectly returned acceptable quality on blocker axes by calling the defects major. This exposed an initial consistency-check gap; the stricter blocker-axis rule and a regression test were added from that result. The preserved response is `tmp/qwen-quality-probe-1788798308396/decision.json`.
- A second real re-review with that stricter rule took 328031ms over six HTTP requests (135584 total tokens). It returned structurally consistent acceptable assessments with EMPTY defect lists and reinterpreted the road pattern as natural asphalt. Both trials archived the candidate on relative preference, but their realism judgments disagreed. The response is `tmp/qwen-quality-probe-1788798767178/decision.json`. The new validator cannot prove an image judgment true when the model fails to acknowledge a visible defect. Semantic detection stability is NOT established or fully solved by this repair.

The local defaults now select Max for new Main/Verifier/Supervisor roles. Routing caches include model IDs and historical runs retain their persisted models. The temporary 360-second request limit is retained; no other deadline was expanded. The 2.1-second probe must not be presented as representative of multi-image evaluation latency.

## Deterministic tonal editing

`photo-editor.ts` decodes through Sharp into sRGB, applies pointwise exposure in linear light, middle-gray contrast, luminance-weighted shadows/highlights, relative warm/cool and magenta/green gains, and saturation. Optional rectangular inward feathering protects pixels outside the region. This is not calibrated Kelvin white balance, semantic masking, segmentation, geometry editing or texture synthesis.

Every preview renders from the explicit immutable base and a complete recipe. Finalization requires that same recipe to have been previewed, records base/recipe/engine provenance, consumes one existing shared candidate unit, and uses the normal view/evaluate/commit gates. Repeated finalization of an unchanged recipe is deduplicated. A previous rendered photo candidate can be revised from its recorded base instead of accumulating processing.

Tests cover neutral pixel identity, repeatability, alpha/dimension preservation, linear-light exposure, outside-region identity, input bounds, public-image access, preview binding, Copilot recipe/scope matching, all four authorized tool sets, and rejection of contradictory inherited-defect assessments. This does not prove the tonal controls alone can meet this task's mountain-geometry requirements.

Verification: 121 automated tests passed, one legacy external SVG-engine integration test was skipped. Workspace type checks, a separate check of the modified scripts, and production build passed. Follow-up quality-consistency regression checks passed after tightening the repair rule.

## Runtime artifacts

Real Main-agent smoke directories:

- Arm 1: `tmp/codex-mcp-smoke-1788798179917`
- Arm 2: `tmp/codex-mcp-smoke-1788798325491`
- Arm 3: `tmp/codex-mcp-smoke-1788798463813`
- Arm 4: `tmp/codex-mcp-smoke-1788798059542`

UI screenshots: `output/playwright/photo-options-desktop.png` and `photo-options-mobile.png`. The real task page showed all three Qwen Max role selections, enabled photo controls, separate trajectory/routing flags and the disabled legacy SVG option. Browser console reported no errors or warnings.

Commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @avo/api exec tsx scripts/run-ablation.ts --treatment photo --suite-id <new-id>
pnpm --filter @avo/api exec tsx scripts/probe-qwen-quality.ts --execute
```

Do not add `--execute` to the ablation command merely to inspect a plan. A new large-scale comparison has not yet established improvement, and a full post-repair 27-image semantic re-ranking has not been performed.
