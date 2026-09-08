import type { ExperimentalFeatures } from "@avo/contracts";

export const ablationFeatures = (treatment: "photo" | "legacy-svg"): ExperimentalFeatures[] => [
  { svg_editing: false, iterative_search: false, copilot_routing: false },
  ...[ [false, false], [true, false], [false, true], [true, true] ].map(([iterative, copilot]) => ({
    svg_editing: treatment === "legacy-svg", photo_adjustments: treatment === "photo",
    iterative_search: Boolean(iterative), copilot_routing: Boolean(copilot),
  })),
];
