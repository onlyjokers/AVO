import type { ExperimentalFeatures } from "@avo/contracts";

export const experimentalToolNames = (features?: Partial<ExperimentalFeatures>): string[] => [
  ...(features?.photo_adjustments ? ["avo_photo_preview", "avo_photo_finalize", "avo_view_detail"] : []),
  ...(features?.svg_editing ? ["avo_svg_tools", "avo_svg_open", "avo_svg_edit", "avo_svg_preview", "avo_svg_finalize"] : []),
  ...(features?.iterative_search ? ["avo_iterative_action"] : []),
  ...(features?.copilot_routing ? ["avo_update_copilot_plan"] : []),
];

export const photoAgentInstructions = `Deterministic photo controls are available through avo_photo_preview(base_artifact_id, recipe) and avo_photo_finalize(base_artifact_id, recipe, description). They adjust existing pixels, without generating new texture. Select the base explicitly as parent first. Recipe fields (all optional): exposure_ev [-3,3] default 0; contrast [0.5,1.5] default 1 around linear middle gray; shadows/highlights [-1,1] default 0; temperature [-1,1] warm positive; tint [-1,1] magenta positive; saturation [0,2] default 1. Temperature/tint are relative gains, not Kelvin. Optional region={x,y,width,height,feather} uses normalized coordinates and an inward feather; pixels outside remain unchanged. No semantic mask or geometry editing is provided.
Preview any recipe, inspect the result, then finalize the SAME base and complete recipe. Every preview renders from its explicit base, not from the previous preview; adjust absolute settings. To revise a prior photo candidate without cumulative processing, use its photo_edit.base_artifact_id and replace its recipe instead of editing the rendered candidate. Finalize spends one shared candidate budget unit and requires normal image viewing/evaluation before another candidate. Parameters and base provenance are retained. A neutral recipe resets to the base pixels, not to a generated approximation. Use avo_view_detail(artifact_id, region) for lossless local evidence; it does not replace viewing the whole candidate.
Treat regeneration degradation as a hypothesis to test: compare Source, actual parent and current candidate at matched regions. When repeated generated texture or drift is visible, consider a Source/clean early base with an updated prompt and permitted references, or deterministic color edits if the remaining gap is tonal. Source-root regeneration can still introduce first-generation defects; do not assume it guarantees realism. You choose the strategy from evidence, not a fixed edit-depth rule.`;

export const allowedAvoTools = (base: readonly string[], features?: Partial<ExperimentalFeatures>) => [
  ...base.filter((name) => !features?.iterative_search || name !== "avo_generate_image"),
  ...experimentalToolNames(features),
];

export const svgAgentInstructions = `You also have a lightweight, deterministic svg-mcp editor. No desktop editor or image regeneration is needed for opacity, text, transforms, masks, gradients, color transfer and compositing.
Call avo_svg_tools once for the available operations, then request an operation's parameter schema when needed. Use avo_svg_open after explicitly selecting its base as parent. It preserves the source canvas dimensions and embeds only permitted images. Use avo_svg_edit to make named-node edits, avo_svg_preview to inspect the working document, and avo_svg_finalize(description) to produce a normal candidate. Each finalized SVG candidate consumes one shared candidate/generation budget unit and must be viewed and evaluated like a generated image. Working-document previews do not create candidates. Use plain image generation for changes these deterministic tools cannot perform; SVG has no neural segmentation, material synthesis or hidden-reference access. Paths or external URLs are not accepted. Reopening a previous SVG candidate preserves its document layers. Do not change colors, layout or add text merely because a tool exists; choose operations based on the user's task and actual feedback.`;
