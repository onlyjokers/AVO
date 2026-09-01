import { readFile } from "node:fs/promises";
import type { AgentRoundContext, AgentToolbox } from "@avo/core";

type Session = { tools: AgentToolbox; context: AgentRoundContext; expiresAt: number; invocations: number };

export class AgentToolBroker {
  private readonly sessions = new Map<string, Session>();

  register(token: string, tools: AgentToolbox, context: AgentRoundContext, ttlMs = 30 * 60_000) {
    this.sessions.set(token, { tools, context, expiresAt: Date.now() + ttlMs, invocations: 0 });
    return () => this.sessions.delete(token);
  }

  async invoke(token: string, name: string, args: Record<string, unknown>) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      throw new Error("invalid_or_expired_tool_session");
    }
    session.invocations += 1;
    if (session.invocations > 32) throw new Error("agent_tool_call_limit_exhausted");
    const tools = session.tools;
    switch (name) {
      case "avo_get_task": return { task: session.context.task, checklist: session.context.checklist };
      case "avo_get_state": return {
        run: tools.getRunSnapshot(),
        recent_attempts: session.context.recentAttempts,
        supervisor_redirect: session.context.supervisorRedirect ?? null,
      };
      case "avo_list_image_pool": return { items: session.context.imagePool.map(({ path: _path, ...item }) => item) };
      case "avo_view_image": {
        const artifactId = String(args.artifact_id ?? "");
        const image = session.context.imagePool.find((item) => item.artifactId === artifactId);
        if (!image) throw new Error("image_not_in_allowed_pool");
        const bytes = await readFile(image.path);
        return { artifact_id: artifactId, bytes_base64: bytes.toString("base64"), mime_type: mimeFromPath(image.path) };
      }
      case "avo_get_prompt": return { prompt: tools.getPrompt() };
      case "avo_set_prompt": tools.setPrompt(String(args.prompt ?? "")); return { ok: true };
      case "avo_append_prompt": tools.appendPrompt(String(args.fragment ?? "")); return { ok: true };
      case "avo_replace_prompt": tools.replacePrompt(String(args.old_text ?? ""), String(args.new_text ?? "")); return { ok: true };
      case "avo_delete_prompt_fragment": tools.deletePromptFragment(String(args.fragment ?? "")); return { ok: true };
      case "avo_select_generation_inputs":
        tools.selectGenerationInputs({
          base_artifact_id: String(args.base_artifact_id ?? ""),
          reference_artifact_ids: Array.isArray(args.reference_artifact_ids) ? args.reference_artifact_ids.map(String) : [],
        });
        return { ok: true };
      case "avo_generate_image": return { artifact_id: await tools.generateImage() };
      case "avo_restore_attempt": await tools.restoreAttempt(String(args.attempt_id ?? "")); return { ok: true };
      case "avo_update_working_memory":
        await tools.updateWorkingMemory({
          useful_findings: strings(args.useful_findings),
          failed_directions: strings(args.failed_directions),
          current_hypotheses: strings(args.current_hypotheses),
          preservation_constraints: strings(args.preservation_constraints),
        });
        return { ok: true };
      case "avo_submit_candidate":
        tools.submitCandidate(String(args.artifact_id ?? ""), {
          observation: String(args.observation ?? ""),
          hypothesis: String(args.hypothesis ?? ""),
          intervention: String(args.intervention ?? ""),
        });
        return { ok: true };
      default: throw new Error("unknown_agent_tool");
    }
  }
}

const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const mimeFromPath = (path: string) => path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : path.endsWith(".webp") ? "image/webp" : "image/png";
