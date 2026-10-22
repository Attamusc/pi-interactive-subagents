# Empty-findings diagnosis

Date: 2026-10-22
Scope: TODO-2c6e541f; synthetic completion-observer fixtures only
Status: one diagnostic fault reproduced; earlier live incidents remain unattributed

## Observations and limits

Three earlier autonomous scouts returned `Sub-agent exited without new output`;
one resumed scout later returned findings. During execution, the diagnostic child
itself exited with status 1 without a graceful completion handshake and produced
no artifact. These are separate observed outcomes, not evidence of one root cause.
No historical session was opened and no live provider or real-Herdr fixture ran.

Development source is `7039646d94c7e783e9b33043db91645f1e1aa723`;
installed source is `d57e498193e9ae25077c8edb0d14cf556808fc63`. The four inspected
completion/session modules have identical working-file bytes across the original
and installed checkouts; `index.ts` differs. Launch parity remains unresolved.
This diagnosis uses an isolated worktree based on the development revision and
leaves the original checkout's existing untracked `context.md` untouched.

The existing real-Herdr test asserts Pi 0.85.1 and sets a macOS Homebrew PATH.
It cannot be claimed as proof of current Fedora/Pi runtime compatibility without
separately reviewed alignment and approval to run it.

## Feedback loop and measured reproduction

Boundary: `waitForVisibleCompletion`, using real package completion records,
real shell-wrapper exit records and runner-owned synthetic session files. This is
observer integration proof, not the complete production parent/child launch path.

Dependencies are reused read-only from the original checkout: a worktree-local,
ignored `node_modules/pi-agent-execution` symlink selects its already-built 0.1.0
library. No package install or build script ran. The original checkout's Pi/TUI
dev dependencies are 0.85.1; Node running the tests is 25.8.1.

Command:

```sh
node --test test/completion-watch.test.ts
```

- Before adding cases: exit 0; 10 tests passed, none skipped.
- With two diagnostic regression cases, before production changes: exit 1;
  10 passed, 2 failed. Both fail because `completion.errorMessage` is absent.
- Malformed case: a fresh assistant finding is followed by malformed synthetic
  JSON. The result is empty output with no read/parse diagnostic.
- Missing-file case: the child records settlement and the shell wrapper proves
  normal exit; removing the synthetic file likewise produces empty output with
  no read/parse diagnostic.
- Tests preserve `execution: normal-exit`: actual shell exit evidence must not be
  changed merely because parent-side output retrieval fails.
- Fixture contents include a synthetic marker to ensure parser error messages
  cannot leak content; no real prompt, transcript, credential or vault was used.

This loop runs in well under a second and fails on the demonstrated boundary.
The cases do not establish that either condition occurred in earlier live runs.

## Ranked explanations

1. **Read/parse failure hidden by observation.** Reproduced. At terminal lifecycle
   state, `completion-watch.ts` catches every `getNewEntries` failure and silently
   substitutes `[]`. `index.ts` then renders the ordinary no-new-output message
   when there is no other error. One malformed new line discards the entire new
   entry selection, including previously parseable findings.
2. **Actual empty latest assistant output.** Supported intentional behavior.
   The existing test forbids reviving stale text for autonomous non-explicit
   completion. Do not change that policy to make empty cases appear successful.
3. **Launch/runtime or session-target mismatch.** Plausible, not reproduced here.
   Different launch source, dependency versions or effective session paths require
   runtime-aligned evidence. Do not infer the answer from identical extraction files.
4. **Provider/startup/child failure before usable output.** Plausible for a failure
   handoff, not demonstrated as the cause of earlier clean empty handoffs. A shell
   status without a graceful completion handshake is not a successful task result.

## Bounded implementation decision

Refine TODO-19ac9885 to preserve read/parse failure as a fixed, content-free
completion diagnostic. Keep an existing structured child/provider error when
present. Do not include `JSON.parse` exception text, arbitrary OS errors, paths,
file contents, or credentials. Do not invent/recover findings from unrelated or
older assistant messages, add retries, change output extraction policy, or alter
normal-exit/process-exit facts and lifecycle ownership.

Keep the two failing fixtures and add positive controls for genuine empty output,
fresh findings, explicit done and existing child errors. A passing fix proves the
new diagnostic distinction, not recovery of unseen historic findings.

TODO-154dcbed must independently verify this narrow contract, red/green evidence,
content privacy and unchanged lifecycle/control behavior. Full production
parent/child runtime proof remains unverified until its separate live-test gate is
approved. If the earlier scout incidents persist, obtain user-authorized bounded
runtime evidence rather than silently expanding into transcript archaeology.
