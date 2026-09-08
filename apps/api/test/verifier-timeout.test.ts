import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { QwenResponsesVerifier } from "../src/http-providers.ts";

test("Verifier retries share one temporary 360-second request deadline", async (t) => {
  const deadlines: number[] = [];
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return deadline.signal; });
  const signals: Array<AbortSignal | null | undefined> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    signals.push(init.signal);
    return new Response("{}", { status: signals.length === 1 ? 503 : 200 });
  });
  const verifier = new QwenResponsesVerifier(loadConfig({}));
  // Exercise the transport boundary without a model call or a six-minute wait.
  const request = Reflect.get(verifier, "request").bind(verifier) as (url: string, init: RequestInit) => Promise<Response>;
  assert.equal((await request("https://verifier.test/responses", {})).status, 200);
  assert.deepEqual(deadlines, [360_000]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  deadline.abort();
  assert.equal(signals[0]!.aborted, true);
});

test("Verifier preserves caller cancellation and configurable shorter deadlines", async (t) => {
  const deadlines: number[] = [];
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return deadline.signal; });
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Response("{}", { status: 200 });
  });
  const verifier = new QwenResponsesVerifier(loadConfig({ AVO_VERIFIER_REQUEST_TIMEOUT_MS: "180000" }));
  const request = Reflect.get(verifier, "request").bind(verifier) as (url: string, init: RequestInit) => Promise<Response>;
  const caller = new AbortController();
  await request("https://verifier.test/responses", { signal: caller.signal });
  assert.deepEqual(deadlines, [180_000]);
  assert.notEqual(signal, caller.signal);
  caller.abort(new Error("run_stopped"));
  assert.equal(signal!.aborted, true);
  assert.equal(signal!.reason.message, "run_stopped");
  assert.throws(() => loadConfig({ AVO_VERIFIER_REQUEST_TIMEOUT_MS: "0" }));
});
