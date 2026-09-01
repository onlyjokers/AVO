import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const api = process.env.AVO_INTERNAL_API;
const token = process.env.AVO_TOOL_TOKEN;
if (!api || !token) throw new Error("AVO MCP requires AVO_INTERNAL_API and AVO_TOOL_TOKEN");

const invoke = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await fetch(`${api}/internal/agent-tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-avo-tool-token": token },
    body: JSON.stringify(args),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error ?? `AVO tool ${name} failed`));
  return result;
};

const textResult = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });

const server = new McpServer({ name: "avo-image-editing", version: "0.1.0" });

server.registerTool("avo_get_task", { description: "Read the immutable image-editing task and verifier checklist." }, async () => textResult(await invoke("avo_get_task")));
server.registerTool("avo_get_state", { description: "Read the current run, recent attempts, memory, and one-shot supervisor redirect." }, async () => textResult(await invoke("avo_get_state")));
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
server.registerTool("avo_list_image_pool", { description: "List source, user reference, and historical candidate artifact IDs allowed for generation." }, async () => textResult(await invoke("avo_list_image_pool")));
server.registerTool("avo_view_image", {
  description: "Inspect one image from the allowed task image pool.",
  inputSchema: { artifact_id: z.string().min(1) },
}, async ({ artifact_id }) => {
  const result = await invoke("avo_view_image", { artifact_id });
  return {
    content: [
      { type: "image" as const, data: String(result.bytes_base64), mimeType: String(result.mime_type) },
      { type: "text" as const, text: JSON.stringify({ artifact_id }) },
    ],
  };
});
server.registerTool("avo_select_generation_inputs", {
  description: "Choose an allowed base image and ordered auxiliary references for the next GPT Image 2 edit.",
  inputSchema: { base_artifact_id: z.string().min(1), reference_artifact_ids: z.array(z.string()) },
}, async (args) => textResult(await invoke("avo_select_generation_inputs", args)));
server.registerTool("avo_generate_image", { description: "Generate one draft with the current prompt and selected images. This spends one generation budget unit." }, async () => textResult(await invoke("avo_generate_image")));
server.registerTool("avo_restore_attempt", {
  description: "Restore a historical attempt as the working prompt and base image without changing lineage.",
  inputSchema: { attempt_id: z.string().min(1) },
}, async ({ attempt_id }) => textResult(await invoke("avo_restore_attempt", { attempt_id })));
server.registerTool("avo_update_working_memory", {
  description: "Replace bounded external working memory with evidence-based findings.",
  inputSchema: {
    useful_findings: z.array(z.string()),
    failed_directions: z.array(z.string()),
    current_hypotheses: z.array(z.string()),
    preservation_constraints: z.array(z.string()),
  },
}, async (args) => textResult(await invoke("avo_update_working_memory", args)));
server.registerTool("avo_submit_candidate", {
  description: "Submit one generated artifact to the controller. This does not verify or commit it.",
  inputSchema: {
    artifact_id: z.string().min(1),
    observation: z.string().min(1),
    hypothesis: z.string().min(1),
    intervention: z.string().min(1),
  },
}, async (args) => textResult(await invoke("avo_submit_candidate", args)));

await server.connect(new StdioServerTransport());
