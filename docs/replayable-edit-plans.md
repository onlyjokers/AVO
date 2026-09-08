# Replayable edit plans and trial evidence

The search should inherit successful instructions without requiring inheritance
of generated pixels. This change adapts the existing AVO search; it does not
replace it with the complete upstream IterativeImageGen or T2ICopilot systems.

## Main tools

- `avo_set_edit_plan` selects an explicit public base, the complete accumulated
  prompt, ordered reference IDs, and exactly one declared use per reference.
  It persists selected inputs and the prompt revision but does not generate.
- `avo_get_trial_evidence` returns immutable candidate inputs, exact prompts,
  reference origins and declared uses, photo recipes, and public review history.
  Retrieve one candidate at a time for long prompts to avoid output clipping.
- Returning to Source does not discard learned instructions. Reuse the saved
  full prompt; replace only the input factor under test. Existing photo tools
  replay an explicit base and absolute recipe, not an incremental adjustment.

## Controlled comparisons

Within the existing shared budget, compare A (Source, no references) with B
(generated base, no references), holding the complete prompt fixed. An optional
C (Source plus generated references) tests references separately. No automatic
extra generations or budget increases are introduced. The Main agent chooses
whether the remaining budget warrants a comparison.

Structured `base_effect` and `reference_effect` claims require exactly two
image-provider drafts, a single changed input factor, and evaluations under the
same saved frame. Different prompts or simultaneous base/reference changes are
observational evidence only. This is input matching, not proof of causality:
provider randomness and unrecorded upstream changes remain possible confounders.

Source plus any reference is not a clean Source-only trial. A clean-source
failure claim also requires an actual failing comparative verdict. Supported
or refuted hypotheses require a structured claim; unknown candidate IDs and
unsupported input claims are rejected before persistence. Supervisor claims
pass the same checks before advice is accepted.

## Reference and reasoning boundaries

Reference purposes (composition, color, texture, identity, other) are provenance
annotations, not masks or isolated channels. They are not automatically added
to the image-provider prompt: Main must express the intended use in its complete
prompt. A generated reference can transfer defects regardless of its declared
purpose. Prefer translating useful structure into text when pixels are unsafe.

Legacy candidates with missing reference-use metadata remain readable and show
unknown use; their history is not rewritten. Supervisor receives complete input
ledgers for the most recent 12 candidates and an index of all candidates.
Free-form diagnosis and memory are still fallible; structured checks cannot
guarantee that every natural-language inference is sound.

## Transport and validation

Iterative MCP actions accept either an object or a JSON string and then apply
the same strict action schema. Failed calls retain call linkage, sanitized
arguments and errors, with bounded diagnostics; malformed raw JSON is omitted.

Offline tests cover real MCP STDIO -> local HTTP -> broker -> runner -> fake
generation, both wire formats, invalid input without generation charges, plan
persistence, reference metadata, hypothesis validation and exact replay evidence.
These checks establish wiring and invariants, not image quality, paid-provider
reliability, or the exact cause of historical MCP failures. Existing experiment
results remain unchanged; a new paid visual study needs separate authorization.
