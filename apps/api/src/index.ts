import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";
import {
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
  SealedEvaluationStore,
} from "@avo/core";
import { createApp } from "./app.ts";
import { BenchmarkRunner } from "./benchmark.ts";
import { CodexAppServerAgentProvider } from "./codex-provider.ts";
import { prepareCodexRuntime } from "./codex-runtime.ts";
import { loadConfig, roleConfig } from "./config.ts";
import { GptImageProvider, QwenResponsesVerifier } from "./http-providers.ts";
import { AgentToolBroker } from "./tool-broker.ts";
import { createCodexProxyConfig } from "./codex-proxy.ts";
import { RoleRouter, defaultProfiles } from "./role-router.ts";
import type { RoleProfiles } from "@avo/contracts";
import { SvgEditor } from "./svg-editor.ts";
import { join } from "node:path";

loadEnv({ path: fileURLToPath(new URL("../../../.env.local", import.meta.url)), quiet: true });
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const baseConfig = loadConfig();
const runtime = await prepareCodexRuntime(roleConfig(baseConfig, "main"));
const config = runtime.config;
const qwenRuntime = await prepareCodexRuntime(roleConfig({ ...baseConfig, AVO_MAIN_PROVIDER: "qwen" }, "main"));
const store = new FileStateStore(config.AVO_DATA_DIR);
const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const sealed = new SealedEvaluationStore(config.AVO_DATA_DIR);
const broker = new AgentToolBroker({
  previewMaxEdge: config.AVO_AGENT_PREVIEW_MAX_EDGE,
  svg: new SvgEditor({ dataDir: config.AVO_DATA_DIR, command: config.AVO_SVG_MCP_COMMAND ?? join(config.AVO_ROOT, "tmp", "svg-mcp-venv", "bin", "svg-mcp") }),
});
const codexProxyToken = randomBytes(32).toString("hex");
const codexProxy = createCodexProxyConfig(roleConfig({ ...baseConfig, AVO_MAIN_PROVIDER: "qwen" }, "main"), codexProxyToken);
const roles = new RoleRouter({ ...baseConfig, AVO_CODEX_BIN: config.AVO_CODEX_BIN }, qwenRuntime.config.AVO_CODEX_MODEL_CATALOG, broker, store, codexProxyToken);

const agent = config.AVO_PROVIDER_MODE === "live"
  ? roles.agent
  : new FakeAgentProvider();
const images = config.AVO_PROVIDER_MODE === "live"
  ? new GptImageProvider(config)
  : new FakeImageProvider();
const verifier = config.AVO_PROVIDER_MODE === "live"
  ? roles.verifier
  : new FakeVerifierProvider(1);

const runner = new AvoRunner(store, artifacts, agent, images, verifier, sealed);
const runDefaults = {
  evaluator_revision: "visual-quality-v2",
  role_profiles: defaultProfiles(baseConfig),
  supervisor_model: roleConfig(baseConfig, "supervisor").AVO_CODEX_MODEL,
  main_model: config.AVO_CODEX_MODEL,
  generator_model: config.AVO_IMAGE_MODEL,
  verifier_model: roleConfig(baseConfig, "verifier").QWEN_MODEL,
  ...(config.AVO_AGENT_TOKEN_LIMIT ? { max_agent_tokens: config.AVO_AGENT_TOKEN_LIMIT } : {}),
  provider_revisions: {
    codex: runtime.codexRevision,
    generator: config.AVO_IMAGE_PROVIDER_REVISION ?? new URL(config.AVO_IMAGE_BASE_URL).host,
    verifier: roleConfig(baseConfig, "verifier").QWEN_PROVIDER_REVISION ?? "qwen",
  },
};
const benchmarks = new BenchmarkRunner(store, runner, runDefaults, config.AVO_BENCHMARK_CONCURRENCY);
const [recoveredRuns, recoveredBenchmarks] = await Promise.all([
  store.recoverInterruptedRuns(),
  store.recoverInterruptedBenchmarks(),
]);
if (recoveredRuns.length || recoveredBenchmarks.length) {
  console.info("Recovered interrupted AVO state", {
    runs: recoveredRuns.length,
    benchmarks: recoveredBenchmarks.length,
  });
}
const healthCache = new Map<string, { promise: ReturnType<typeof probeProviders>; failedAt: number }>();
const boundedProbe = async (
  name: string,
  probe: (signal: AbortSignal) => Promise<{ ok: boolean; message: string }>,
) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: boolean; message: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${name}_probe_timeout`));
      resolve({ ok: false, message: `${name} capability probe 超过 ${config.AVO_PROVIDER_PROBE_TIMEOUT_MS}ms` });
    }, config.AVO_PROVIDER_PROBE_TIMEOUT_MS);
  });
  const operation = probe(controller.signal).catch((error) => ({ ok: false, message: `${name} probe 失败：${(error as Error).message}` }));
  const result = await Promise.race([operation, timeout]);
  if (timer) clearTimeout(timer);
  return result;
};
const probeProviders = async (profiles: RoleProfiles) => {
  const [codex, generator, verifierHealth] = await Promise.all([
    boundedProbe("Codex", (signal) => config.AVO_PROVIDER_MODE === "live" ? roles.agentFor(profiles).probe(signal) : agent.probe(signal)),
    boundedProbe("Image Provider", (signal) => images.probe(signal)),
    boundedProbe("Verifier", (signal) => config.AVO_PROVIDER_MODE === "live" ? roles.verifierFor(profiles.verifier).probe(signal) : verifier.probe(signal)),
  ]);
  return {
    codex: { enabled: config.AVO_PROVIDER_MODE === "live", ...codex },
    generator: { enabled: config.AVO_PROVIDER_MODE === "live", ...generator },
    verifier: { enabled: config.AVO_PROVIDER_MODE === "live", ...verifierHealth },
    runnable: codex.ok && generator.ok && verifierHealth.ok,
    mode: config.AVO_PROVIDER_MODE,
  };
};
const providerHealth = async (profiles = defaultProfiles(baseConfig)) => {
  const key = JSON.stringify(profiles);
  let cached = healthCache.get(key);
  if (!cached || (cached.failedAt && Date.now() - cached.failedAt >= 30_000)) {
    cached = { promise: probeProviders(profiles), failedAt: 0 };
    healthCache.set(key, cached);
  }
  const health = await cached.promise;
  if (!health.runnable && !cached.failedAt) cached.failedAt = Date.now();
  return health;
};

const app = await createApp({
  config,
  store,
  artifacts,
  sealed,
  runner,
  benchmarks,
  broker,
  runDefaults,
  providerHealth,
  modelProfiles: {
    defaults: defaultProfiles(baseConfig),
    options: (["qwen", "78code"] as const).map((id) => ({ id, model: roles.configFor(id, "main").AVO_CODEX_MODEL, configured: Boolean(roles.configFor(id, "main").AVO_CODEX_PROVIDER_API_KEY) })),
  },
  resolveRunModels: (profiles) => ({
    main_model: roles.configFor(profiles.main, "main").AVO_CODEX_MODEL,
    verifier_model: roles.configFor(profiles.verifier, "verifier").QWEN_MODEL,
    supervisor_model: roles.configFor(profiles.supervisor, "supervisor").AVO_CODEX_MODEL,
    provider_revisions: { ...runDefaults.provider_revisions, verifier: roles.configFor(profiles.verifier, "verifier").QWEN_PROVIDER_REVISION ?? profiles.verifier },
  }),
  ...(codexProxy ? { codexProxy } : {}),
});
await app.listen({ host: config.AVO_HOST, port: config.AVO_API_PORT });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
