import type { RoleProfiles, RunConfig } from "@avo/contracts";
import type { AgentProvider, AgentRoundContext, AgentToolbox, FileStateStore, VerifierProvider } from "@avo/core";
import { type AppConfig, roleConfig } from "./config.ts";
import { CodexAppServerAgentProvider } from "./codex-provider.ts";
import { QwenResponsesVerifier } from "./http-providers.ts";
import type { AgentToolBroker } from "./tool-broker.ts";

export const defaultProfiles = (config: AppConfig): RoleProfiles => ({ main: config.AVO_MAIN_PROVIDER, verifier: config.AVO_VERIFIER_PROVIDER, supervisor: config.AVO_SUPERVISOR_PROVIDER });
export const profilesForRun = (config: RunConfig): RoleProfiles => config.role_profiles ?? {
  main: config.main_model === "gpt-6-astra" ? "78code" : "qwen",
  verifier: config.verifier_model === "gpt-6-astra" ? "78code" : "qwen",
  supervisor: (config.supervisor_model ?? config.main_model) === "gpt-6-astra" ? "78code" : "qwen",
};

export class RoleRouter {
  private readonly agents = new Map<string, CodexAppServerAgentProvider>();
  private readonly verifiers = new Map<string, QwenResponsesVerifier>();
  constructor(private readonly config: AppConfig, private readonly qwenCatalog: string | undefined, private readonly broker: AgentToolBroker, private readonly store: FileStateStore, private readonly token: string) {}

  configFor(provider: "qwen" | "78code", role: "main" | "verifier" | "supervisor", model?: string) {
    const resolved = roleConfig({ ...this.config, AVO_MAIN_PROVIDER: provider, AVO_VERIFIER_PROVIDER: provider, AVO_SUPERVISOR_PROVIDER: provider }, role);
    return { ...resolved,
      ...(model ? { AVO_CODEX_MODEL: model, QWEN_MODEL: model, QWEN_PROVIDER_REVISION: `${provider}:${model}` } : {}),
      AVO_CODEX_MODEL_CATALOG: provider === "qwen" ? this.qwenCatalog : undefined };
  }

  agentFor(profiles: RoleProfiles, models?: Pick<RunConfig, "main_model" | "supervisor_model">) {
    const main = this.configFor(profiles.main, "main", models?.main_model);
    const supervisor = this.configFor(profiles.supervisor, "supervisor", models?.supervisor_model ?? models?.main_model);
    const key = `${profiles.main}:${main.AVO_CODEX_MODEL}:${profiles.supervisor}:${supervisor.AVO_CODEX_MODEL}`;
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new CodexAppServerAgentProvider(main, this.broker, this.store, this.token, supervisor);
      this.agents.set(key, agent);
    }
    return agent;
  }

  verifierFor(provider: "qwen" | "78code", model?: string) {
    const config = this.configFor(provider, "verifier", model);
    const key = `${provider}:${config.QWEN_MODEL}`;
    let verifier = this.verifiers.get(key);
    if (!verifier) { verifier = new QwenResponsesVerifier(config); this.verifiers.set(key, verifier); }
    return verifier;
  }

  readonly agent: AgentProvider = {
    id: "role-routed-codex",
    probe: (signal) => this.agentFor(defaultProfiles(this.config)).probe(signal),
    runRound: (context: AgentRoundContext, tools: AgentToolbox) => this.agentFor(profilesForRun(context.run.config), context.run.config).runRound(context, tools),
    planBestOf: (context, count) => this.agentFor(profilesForRun(context.run.config), context.run.config).planBestOf(context, count),
    supervise: (context, request) => this.agentFor(profilesForRun(context.run.config), context.run.config).supervise(context, request),
  };

  private async forRun(runId: string) {
    const { config } = await this.store.getRun(runId);
    return this.verifierFor(profilesForRun(config).verifier, config.verifier_model);
  }

  readonly verifier: VerifierProvider = {
    id: "role-routed-verifier",
    probe: (signal) => this.verifierFor(this.config.AVO_VERIFIER_PROVIDER).probe(signal),
    createChecklist: (input) => this.verifierFor(this.config.AVO_VERIFIER_PROVIDER).createChecklist(input),
    verify: async (input) => (await this.forRun(input.runId)).verify(input),
    createEvaluationFrame: async (input) => (await this.forRun(input.runId)).createEvaluationFrame(input),
    compare: async (input) => (await this.forRun(input.runId)).compare(input),
    selectFinal: async (input) => (await this.forRun(input.runId)).selectFinal(input),
    reviewLineage: async (input) => (await this.forRun(input.runId)).reviewLineage(input),
  };
}
