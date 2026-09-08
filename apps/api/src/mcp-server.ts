import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { internalToolRequest } from "./internal-tool-request.ts";
import { experimentalFeaturesSchema, generationInputSchema, referenceUsageSchema, trialClaimSchema } from "@avo/contracts";
import { iterativeWireSchema, parseIterativeAction } from "./experiment-iterative.ts";
import { copilotPlanInputSchema } from "./experiment-copilot.ts";
import { photoRecipeSchema, photoRegionSchema } from "./photo-editor.ts";

const api = process.env.AVO_INTERNAL_API;
const token = process.env.AVO_TOOL_TOKEN;
const maxTextChars = Number(process.env.AVO_TOOL_OUTPUT_MAX_CHARS ?? 12_000);
if (!api || !token) throw new Error("AVO MCP requires AVO_INTERNAL_API and AVO_TOOL_TOKEN");

const invoke = async (name: string, args: Record<string, unknown> = {}) => {
  return internalToolRequest(`${api}/internal/agent-tools/${name}`, token!, args, Number(process.env.AVO_TOOL_WAIT_TIMEOUT_MS ?? 1_320_000));
};

const textResult = (result: unknown) => {
  const serialized = JSON.stringify(result, null, 2);
  const text = serialized.length <= maxTextChars
    ? serialized
    : JSON.stringify({
        clipped: true,
        preview: serialized.slice(0, Math.max(1_000, maxTextChars - 200)),
        instruction: "Use a focused read tool for more detail.",
      });
  return { content: [{ type: "text" as const, text }] };
};

const stringArrayInput = z.union([z.array(z.string()), z.string()]);
const workingMemoryObjectInput = z.object({
  useful_findings: stringArrayInput,
  failed_directions: stringArrayInput,
  current_hypotheses: stringArrayInput,
  preservation_constraints: stringArrayInput,
});
const workingMemoryInput = z.union([workingMemoryObjectInput, z.string()]);

const parseStringArray = (value: string[] | string) => {
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("invalid_string_array");
  return parsed;
};

const parseWorkingMemory = (value: z.infer<typeof workingMemoryInput>) => {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const memory = workingMemoryObjectInput.parse(parsed);
  return {
    useful_findings: parseStringArray(memory.useful_findings),
    failed_directions: parseStringArray(memory.failed_directions),
    current_hypotheses: parseStringArray(memory.current_hypotheses),
    preservation_constraints: parseStringArray(memory.preservation_constraints),
  };
};

const server = new McpServer({ name: "avo-image-editing", version: "0.1.0" });
const experimentalFeatures = process.env.AVO_EXPERIMENTAL_FEATURES
  ? experimentalFeaturesSchema.parse(JSON.parse(process.env.AVO_EXPERIMENTAL_FEATURES)) : undefined;

if (experimentalFeatures?.photo_adjustments) {
  for (const name of ["avo_photo_preview", "avo_photo_finalize"] as const) server.registerTool(name, {
    description: name === "avo_photo_preview"
      ? "Preview deterministic exposure, contrast, shadows/highlights, temperature/tint and saturation from an explicit immutable base. Does not synthesize texture or spend a candidate unit. Settings replace, not accumulate."
      : "Finalize the same previewed base and recipe into a normal candidate, spending one shared candidate unit. Requires explicit parent selection and a matching Copilot plan when enabled; then view and evaluate the draft.",
    inputSchema: { base_artifact_id: z.string().min(1), recipe: photoRecipeSchema,
      ...(name === "avo_photo_finalize" ? { description: z.string().min(1) } : {}) },
  }, async (args) => {
    const result = await invoke(name, args);
    const { bytes_base64, mime_type, ...metadata } = result;
    return typeof bytes_base64 === "string" && typeof mime_type === "string"
      ? { content: [{ type: "image" as const, data: bytes_base64, mimeType: mime_type }, { type: "text" as const, text: JSON.stringify(metadata) }] }
      : textResult(result);
  });
  server.registerTool("avo_view_detail", {
    description: "Inspect a lossless PNG crop from the controlled image pool. Use the same normalized region on Source/Parent/Candidate to test degradation hypotheses. Crops do not replace whole-candidate viewing.",
    inputSchema: { artifact_id: z.string().min(1), region: photoRegionSchema },
  }, async (args) => {
    const { bytes_base64, mime_type, ...metadata } = await invoke("avo_view_detail", args);
    return { content: [{ type: "image" as const, data: String(bytes_base64), mimeType: String(mime_type) }, { type: "text" as const, text: JSON.stringify(metadata) }] };
  });
}

if (experimentalFeatures?.svg_editing) {
  server.registerTool("avo_svg_tools", {
    description: "Discover the allowed deterministic svg-mcp operations, or read one exact operation parameter schema. No desktop software is used.",
    inputSchema: { operation: z.string().optional() },
  }, async (args) => textResult(await invoke("avo_svg_tools", args)));
  server.registerTool("avo_svg_open", {
    description: "Create an editable SVG document on the source-size canvas from the explicitly selected public parent. Reopens layers when the parent was an SVG candidate.",
    inputSchema: { parent_artifact_id: z.string().min(1) },
  }, async (args) => textResult(await invoke("avo_svg_open", args)));
  server.registerTool("avo_svg_edit", {
    description: "Perform a deterministic operation on a working SVG document. Use avo_svg_tools(operation) for exact parameters. Parameters are JSON; add_image accepts artifact_id instead of filesystem paths/URLs. Preview then finalize when ready.",
    inputSchema: { document_id: z.string().min(1), operation: z.string().min(1), parameters: z.string().describe("JSON object of parameters for the selected upstream operation") },
  }, async (args) => textResult(await invoke("avo_svg_edit", args)));
  server.registerTool("avo_svg_preview", {
    description: "See a 1024px analysis preview of a working SVG document. This is not a finalized/evaluated candidate.",
    inputSchema: { document_id: z.string().min(1) },
  }, async (args) => {
    const result = await invoke("avo_svg_preview", args);
    const { bytes_base64, mime_type, ...metadata } = result;
    if (typeof bytes_base64 !== "string" || typeof mime_type !== "string") return textResult(result);
    return { content: [
      { type: "image" as const, data: bytes_base64, mimeType: mime_type },
      { type: "text" as const, text: JSON.stringify(metadata) },
    ] };
  });
  server.registerTool("avo_svg_finalize", {
    description: "Render the full-size edited SVG into an ordinary Draft. Spends ONE shared candidate/generation budget unit. Must then call avo_view_image and avo_evaluate_draft; cannot bypass Verifier or lineage rules.",
    inputSchema: { document_id: z.string().min(1), description: z.string().min(1).describe("Your authored edit intention and changes, recorded as this candidate's prompt") },
  }, async (args) => textResult(await invoke("avo_svg_finalize", args)));
}
if (experimentalFeatures?.iterative_search) {
  server.registerTool("avo_iterative_action", {
    description: "Perform FRESH_START (new named Source-rooted strategy), CONTINUE (trajectory head), BACKTRACK (ancestor), ADOPT (attach an already viewed/evaluated SVG or generated child to the named path, no generation), or STOP. Generating actions create exactly one ordinary image candidate and share the existing budget. Inspect and evaluate before the next action.",
    inputSchema: { action: iterativeWireSchema },
  }, async ({ action }) => textResult(await invoke("avo_iterative_action", { action: parseIterativeAction(action) })));
}
if (experimentalFeatures?.copilot_routing) {
  server.registerTool("avo_update_copilot_plan", {
    description: "Record a complete revisable interpretation and operation plan based ONLY on public brief quotes. Match route/base/prompt or SVG command+arguments before editing. Use capability image_generator or svg_edit. The plan never changes the task or Verifier criteria.",
    inputSchema: { plan: copilotPlanInputSchema },
  }, async (args) => textResult(await invoke("avo_update_copilot_plan", args)));
}

server.registerTool("avo_get_task", { description: "Read the immutable image-editing task and verifier checklist." }, async () => textResult(await invoke("avo_get_task")));
server.registerTool("avo_set_edit_plan", {
  description: "Set a complete replayable generation plan: explicit base, complete accumulated prompt, ordered public references and one declared use per reference. Image inheritance is optional; keep learned instructions when returning to Source. Reference purpose is guidance, NOT enforced masking.",
  inputSchema: { base_artifact_id: z.string().min(1), prompt: z.string().min(1), reference_artifact_ids: stringArrayInput,
    reference_usage: z.array(referenceUsageSchema) },
}, async ({ reference_artifact_ids, ...args }) => textResult(await invoke("avo_set_edit_plan", {
  ...args, reference_artifact_ids: parseStringArray(reference_artifact_ids),
})));
server.registerTool("avo_get_trial_evidence", {
  description: "Read complete saved candidate inputs, reference origin/use/risk, prompt, photo recipe, review history and replay data. One candidate by default; request specific draft IDs. Source plus a generated reference is NOT a clean Source-only trial.",
  inputSchema: { draft_ids: z.array(z.string().min(1)).min(1).max(4).optional() },
}, async (args) => textResult(await invoke("avo_get_trial_evidence", args)));
server.registerTool("avo_get_state", { description: "Read the current run, recent attempts, memory, and one-shot supervisor redirect." }, async () => textResult(await invoke("avo_get_state")));
server.registerTool("avo_get_lineage", { description: "Read the official single lineage x0 -> x1 -> x2 and the current incumbent." }, async () => textResult(await invoke("avo_get_lineage")));
server.registerTool("avo_get_memory", { description: "Read current working memory, memory revisions, and hypotheses." }, async () => textResult(await invoke("avo_get_memory")));
server.registerTool("avo_get_evaluation", {
  description: "Read one cached deterministic and VLM evaluation visible to the Main Agent.",
  inputSchema: { evaluation_id: z.string().min(1) },
}, async ({ evaluation_id }) => textResult(await invoke("avo_get_evaluation", { evaluation_id })));
server.registerTool("avo_get_prompt", { description: "Read the current GPT Image 2 prompt." }, async () => textResult(await invoke("avo_get_prompt")));
server.registerTool("avo_set_prompt", {
  description: "Replace the current GPT Image 2 prompt.",
  inputSchema: { prompt: z.string().min(1) },
}, async ({ prompt }) => textResult(await invoke("avo_set_prompt", { prompt })));
server.registerTool("avo_append_prompt", {
  description: "Append a focused fragment to the current prompt.",
  inputSchema: { fragment: z.string().min(1) },
}, async ({ fragment }) => textResult(await invoke("avo_append_prompt", { fragment })));
server.registerTool("avo_replace_prompt", {
  description: "Replace one exact prompt fragment.",
  inputSchema: { old_text: z.string().min(1), new_text: z.string() },
}, async (args) => textResult(await invoke("avo_replace_prompt", args)));
server.registerTool("avo_delete_prompt_fragment", {
  description: "Delete one exact prompt fragment.",
  inputSchema: { fragment: z.string().min(1) },
}, async ({ fragment }) => textResult(await invoke("avo_delete_prompt_fragment", { fragment })));
server.registerTool("avo_select_parent", {
  description: "Explicitly choose source, a committed lineage node, or a safe historical draft as the next edit parent.",
  inputSchema: {
    parent_node_id: z.string().min(1),
    rationale: z.string().min(1),
    override_rationale: z.string().min(1).optional(),
  },
}, async (args) => textResult(await invoke("avo_select_parent", args)));
server.registerTool("avo_select_references", {
  description: "Choose zero or more public task artifacts as auxiliary generation references.",
  inputSchema: { artifact_ids: stringArrayInput },
}, async ({ artifact_ids }) => textResult(await invoke("avo_select_references", { artifact_ids: parseStringArray(artifact_ids) })));
server.registerTool("avo_list_image_pool", { description: "List source, user reference, and historical candidate artifact IDs allowed for generation." }, async () => textResult(await invoke("avo_list_image_pool")));
server.registerTool("avo_view_image", {
  description: "Inspect one image from the allowed task image pool.",
  inputSchema: { artifact_id: z.string().min(1) },
}, async ({ artifact_id }) => {
  const result = await invoke("avo_view_image", { artifact_id });
  if (typeof result.bytes_base64 !== "string" || typeof result.mime_type !== "string") {
    return textResult(result);
  }
  const { bytes_base64: _bytes, mime_type: mimeType, ...metadata } = result;
  return {
    content: [
      { type: "image" as const, data: String(result.bytes_base64), mimeType: String(mimeType) },
      { type: "text" as const, text: JSON.stringify(metadata) },
    ],
  };
});
server.registerTool("avo_select_generation_inputs", {
  description: "Choose an allowed base image and ordered auxiliary references for the next GPT Image 2 edit.",
  inputSchema: { base_artifact_id: z.string().min(1), reference_artifact_ids: stringArrayInput, reference_usage: generationInputSchema.shape.reference_usage },
}, async ({ base_artifact_id, reference_artifact_ids, reference_usage }) => textResult(await invoke("avo_select_generation_inputs", {
  base_artifact_id,
  reference_artifact_ids: parseStringArray(reference_artifact_ids),
  ...(reference_usage ? { reference_usage } : {}),
})));
if (!experimentalFeatures?.iterative_search) server.registerTool("avo_generate_image", { description: "Generate one draft with the current prompt and selected images. This spends one generation budget unit." }, async () => textResult(await invoke("avo_generate_image")));
server.registerTool("avo_evaluate_draft", {
  description: "Run deterministic quality-debt validators and the cached semantic evaluator on a viewed draft. Returns exact draft/evaluation IDs, remaining generation budget, and the allowed next decision. Accepts either its draft ID or artifact ID.",
  inputSchema: { draft_id: z.string().min(1) },
}, async ({ draft_id }) => textResult(await invoke("avo_evaluate_draft", { draft_id })));
server.registerTool("avo_restore_attempt", {
  description: "Restore a historical attempt as the working prompt and base image without changing lineage.",
  inputSchema: { attempt_id: z.string().min(1) },
}, async ({ attempt_id }) => textResult(await invoke("avo_restore_attempt", { attempt_id })));
server.registerTool("avo_decline_pending_decision", {
  description: "Decline carried candidates with a rationale, then continue autonomous search in the current Step.",
  inputSchema: { rationale: z.string().min(1) },
}, async ({ rationale }) => textResult(await invoke("avo_decline_pending_decision", { rationale })));
server.registerTool("avo_update_working_memory", {
  description: "Replace bounded external working memory with evidence-based findings.",
  inputSchema: {
    useful_findings: stringArrayInput,
    failed_directions: stringArrayInput,
    current_hypotheses: stringArrayInput,
    preservation_constraints: stringArrayInput,
  },
}, async (args) => textResult(await invoke("avo_update_working_memory", parseWorkingMemory(args))));
server.registerTool("avo_upsert_hypothesis", {
  description: "Create or update a hypothesis with status and evidence references.",
  inputSchema: {
    id: z.string().min(1),
    statement: z.string().min(1),
    status: z.enum(["proposed", "active", "supported", "refuted", "retired"]),
    evidence_refs: stringArrayInput,
    trial_claim: trialClaimSchema.optional(),
    alternative_explanations: z.array(z.string().min(1)).max(20).optional(),
  },
}, async ({ evidence_refs, ...args }) => textResult(await invoke("avo_upsert_hypothesis", { ...args, evidence_refs: parseStringArray(evidence_refs) })));
const abandonAttemptTool = {
  description: "End the current autonomous Variation Attempt without changing the official evolution version.",
  inputSchema: {
    reason: z.string().min(1),
    observation: z.string().min(1),
    hypothesis: z.string().min(1),
    intervention: z.string().min(1),
    memory_update: workingMemoryInput,
  },
} as const;
server.registerTool("avo_abandon_attempt", abandonAttemptTool, async ({ memory_update, ...args }) => textResult(await invoke("avo_abandon_attempt", { ...args, memory_update: parseWorkingMemory(memory_update) })));
server.registerTool("avo_abandon_step", {
  ...abandonAttemptTool,
  description: "Compatibility alias for avo_abandon_attempt.",
}, async ({ memory_update, ...args }) => textResult(await invoke("avo_abandon_step", { ...args, memory_update: parseWorkingMemory(memory_update) })));
server.registerTool("avo_submit_candidate", {
  description: "Commit a viewed draft only when the current Agentic Verifier decision recommends commit against the incumbent.",
  inputSchema: {
    draft_id: z.string().min(1),
    decision_id: z.string().min(1),
    observation: z.string().min(1),
    hypothesis: z.string().min(1),
    intervention: z.string().min(1),
    memory_update: workingMemoryInput,
  },
}, async ({ memory_update, ...args }) => textResult(await invoke("avo_submit_candidate", { ...args, memory_update: parseWorkingMemory(memory_update) })));

await server.connect(new StdioServerTransport());
