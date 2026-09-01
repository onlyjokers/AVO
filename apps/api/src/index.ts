import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
} from "@avo/core";
import { createApp } from "./app.ts";
import { BenchmarkRunner } from "./benchmark.ts";
import { CodexAppServerAgentProvider } from "./codex-provider.ts";
import { prepareCodexRuntime } from "./codex-runtime.ts";
import { loadConfig } from "./config.ts";
import { GptImageProvider, QwenResponsesVerifier } from "./http-providers.ts";
import { AgentToolBroker } from "./tool-broker.ts";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const runtime = await prepareCodexRuntime(loadConfig());
const config = runtime.config;
const store = new FileStateStore(config.AVO_DATA_DIR);
const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const broker = new AgentToolBroker();

const agent = config.AVO_PROVIDER_MODE === "live"
  ? new CodexAppServerAgentProvider(config, broker, store)
  : new FakeAgentProvider();
const images = config.AVO_PROVIDER_MODE === "live"
  ? new GptImageProvider(config)
  : new FakeImageProvider();
const verifier = config.AVO_PROVIDER_MODE === "live"
  ? new QwenResponsesVerifier(config)
  : new FakeVerifierProvider();

const runner = new AvoRunner(store, artifacts, agent, images, verifier);
const runDefaults = {
  main_model: config.AVO_CODEX_MODEL,
  generator_model: config.AVO_IMAGE_MODEL,
  verifier_model: config.QWEN_MODEL,
  provider_revisions: {
    codex: runtime.codexRevision,
    generator: config.AVO_IMAGE_PROVIDER_REVISION ?? new URL(config.AVO_IMAGE_BASE_URL).host,
    verifier: config.QWEN_PROVIDER_REVISION ?? (config.QWEN_BASE_URL ? new URL(config.QWEN_BASE_URL).host : "unconfigured"),
  },
};
const benchmarks = new BenchmarkRunner(store, runner, runDefaults);
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
let providerHealthPromise: ReturnType<typeof probeProviders> | undefined;
const probeProviders = async () => {
  const [codex, generator, verifierHealth] = await Promise.all([agent.probe(), images.probe(), verifier.probe()]);
  return {
    codex: { enabled: config.AVO_PROVIDER_MODE === "live", ...codex },
    generator: { enabled: config.AVO_PROVIDER_MODE === "live", ...generator },
    verifier: { enabled: config.AVO_PROVIDER_MODE === "live", ...verifierHealth },
    runnable: codex.ok && generator.ok && verifierHealth.ok,
    mode: config.AVO_PROVIDER_MODE,
  };
};
const providerHealth = () => providerHealthPromise ??= probeProviders();

const app = await createApp({ config, store, artifacts, runner, benchmarks, broker, runDefaults, providerHealth });
await app.listen({ host: config.AVO_HOST, port: config.AVO_API_PORT });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
