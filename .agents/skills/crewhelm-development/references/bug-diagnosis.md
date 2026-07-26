# Bug diagnosis

Read this reference for a bug or performance regression.

## Build the feedback loop first

Name one fast, deterministic command that exercises the reported behavior and can fail on the exact
symptom. Prefer, in order:

1. A focused test at the affected interface.
2. A CLI or HTTP invocation with fixed input and an explicit expected result.
3. A replayable trace, provider fixture, or local harness.
4. A seeded stress, differential, or bisection loop for intermittent failures.

Do not form a fix around a nearby failure. Reproduce the user's symptom, then remove inputs,
configuration, and steps one at a time until every remaining element is necessary.

## Test hypotheses

For a non-obvious, intermittent, or performance-sensitive failure, write three to five ranked,
falsifiable hypotheses. Each must predict what a specific probe will change. For a direct failure
with a clear cause, state and test that cause without manufacturing alternatives. Test one
variable at a time; prefer debugger inspection or targeted measurements over broad logging. Tag
temporary instrumentation so it is easy to find and remove.

For performance work, establish a repeatable baseline before changing code.

## Fix and prove

At the correct public seam:

1. Turn the minimized reproduction into a failing regression test.
2. Observe the intended failure.
3. Apply the smallest complete fix.
4. Observe the regression test pass.
5. Re-run the original, unminimized feedback loop and the repository gate.

If no seam can reproduce the real failure, record that design limitation rather than adding a
shallow test that creates false confidence.

Before committing, remove temporary instrumentation and harnesses, then state the verified cause
in the commit explanation.

This loop is adapted from Matt Pocock's MIT-licensed
[diagnosing-bugs skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs).
