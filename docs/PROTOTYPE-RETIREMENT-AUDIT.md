# Prototype retirement audit

This audit compares the retained prototypes with the tested runtime on `main`. It records why their source was removed from the active tree. Git history remains the archival authority for their exact implementations.

## DataFactory VS Code extension 0.2.0

Observed implementation:

- inspected Git root, branch, commit, and short status;
- normalized a text goal;
- generated a deterministic order ID from time, commit, and goal;
- attached four fixed policy constraints and four fixed return requirements;
- formatted that order as a provider-neutral text packet;
- stored orders under `.datafactory/orders` and rendered PROJECT, WORK, INSPECT, and CHAT panels;
- passed its four unit tests before retirement.

Comparison with current CommandHUD:

| Prototype behavior | Current authority | Decision |
| --- | --- | --- |
| Git identity and dirty state | verified project resolution, Git snapshots, and repository currency | superseded |
| text goal | objective and frontier working state, plus per-run request/objective | superseded |
| deterministic order record | immutable run and workflow records with observed execution evidence | superseded by stronger factual records |
| agent packet | operation handoff, run packet, workflow packet, and continuation | superseded |
| fixed constraints | documentation/policy text with no runtime enforcement | reject as a product capability |
| fixed required-evidence list | actual stdout, stderr, exit, duration, Git before/after, delta, and verification reduction | superseded by observed evidence |
| VS Code panel | terminal UI and local desktop/visual clients over the canonical runtime | superseded |

The fixed constraints were sensible instructions, but printing policy text is not enforcement. Copying them into every modern packet would add bulk without adding authority. No extension behavior justified retaining a second product frontend or state store.

## Command HUD v21 Windows Forms prototypes

Observed implementation:

- persistent PowerShell runspace and working directory;
- asynchronous execution, live polling, cancellation, and session JSONL history;
- latest-output and all-history clipboard actions;
- click-to-copy, click-to-paste/optional auto-run, and mouse-wheel command history;
- separate live-output window, animated face, status palette, and input-boundary bell suppression;
- later bridge routing into a selected repository's copied HUD core and workflow prefix grammar.

Comparison with current CommandHUD:

| Prototype behavior | Current authority | Decision |
| --- | --- | --- |
| persistent cwd | repository-contained cwd across terminal commands and major shells | superseded and hardened |
| async execution/cancellation | runtime-owned process lifecycle, bounded live evidence, cancellation, and interrupted-run recovery | superseded and hardened |
| JSONL session logs | immutable per-project run directories with raw streams and structured records | superseded |
| latest copy | automatic compact handoff plus explicit copy | superseded |
| entire transcript copy | immutable History and bounded evidence access | reject as the default LLM context path |
| command history | standard readline history and immutable operation History | superseded |
| animated face/status | factual fixed-row TUI animation with reduced-motion boundaries | superseded |
| click paste with auto-run | ordinary paste followed by explicit Enter | reject automatic execution as an unsafe default |
| separate live window | stable TUI output region and desktop live operation view | superseded |
| repository core bridge | one installed generic runtime plus project-owned declarations | superseded; copied project runtimes are prohibited |

The old scripts were valuable behavioral sources, but retaining runnable legacy launchers made the product authority ambiguous. Their useful contracts are now tested in the current package; rejected interactions are recorded above rather than silently forgotten.

## Stale DATA example

The old `examples/digital-breakdown.project.json` described DATA as a private, read-only discovery fixture and prohibited modification. Current integration is owned by DATA's real project declaration and thin launchers. The example was therefore neither generic documentation nor current DATA authority and was removed.

## Retirement evidence

Before removal:

- current CommandHUD suite: 57/57 passed;
- DataFactory extension syntax checks passed;
- DataFactory order tests: 4/4 passed;
- the portable distribution wrapper had already been separately audited and removed.

After removal, the current CommandHUD suite remains the required regression authority. Historical source can be recovered from commit `86deeb4` or earlier without keeping parallel runnable systems in the active tree.
