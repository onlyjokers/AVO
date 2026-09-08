# Qwen Token Plan routing

Set these values in the ignored `.env.local` file:

```dotenv
QWEN_BILLING_MODE=token_plan
QWEN_TOKEN_PLAN_API_KEY=<your dedicated sk-sp- key>
AVO_MAIN_PROVIDER=qwen
AVO_VERIFIER_PROVIDER=qwen
AVO_SUPERVISOR_PROVIDER=qwen
AVO_CODEX_MODEL=qwen3.8-max
QWEN_MODEL=qwen3.8-max
```

Token Plan mode pins the Qwen and Codex-proxy upstreams to
`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
It ignores old general-key and custom-provider overrides. A missing dedicated key
leaves Qwen unconfigured; a general key in the dedicated field is rejected.
The Codex client must not fall back to its default provider when that key is absent.

An existing `QWEN_API_KEY` is accepted only if it already has the `sk-sp-` prefix;
`QWEN_TOKEN_PLAN_API_KEY` takes precedence. Prefix validation prevents common
misconfiguration but does not prove account entitlement or successful billing.

After adding the key, restart the API and verify a small Qwen Responses request
against the dedicated endpoint, then confirm the corresponding Token Plan usage
in the account console. Never log complete keys or automatically retry through
the general API endpoint. Do not resume the stopped experiment without checking
its billing and frozen configuration provenance.

This changes only Qwen Main, Verifier and Supervisor routing. The separate
GPT Image 2 generator remains on its existing provider and billing channel.

Reference: https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-quickstart

## Verified local setup (2026-09-08)

The dedicated personal-plan key was created with user confirmation and stored only
in ignored `.env.local` with owner-only permissions. Three tiny requests against
the Token Plan endpoint verified `qwen3.8-max` text output, image understanding,
function calling, and stored Responses continuation (766 reported tokens total).
No general-endpoint retry was used. Main, Verifier and Supervisor share the
dedicated configuration. The usage dashboard still rounded remaining allowance
to 100.0%; this is endpoint/authentication verification, not an itemized billing
reconciliation. The stopped five-arm study remains stopped.
