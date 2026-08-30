# Product contract

## User outcome

Paste an ordinary command into a repository-aware terminal, let the real machine execute it, retain the complete evidence, and receive a compact truthful result that is easy to paste back into an LLM.

CommandHUD is local-first developer tooling. It does not replace Git, shells, repository scripts, or the filesystem; it makes their state and consequences easier to operate and transfer.

## Primary loop

```text
LLM command
  -> paste into CommandHUD
  -> execute in an explicit shell and verified repository cwd
  -> preserve raw stdout, stderr, exit status, duration, and Git state
  -> derive bounded deterministic context
  -> copy compact handoff
  -> paste back into the LLM
```

## Current interfaces

| Interface | Purpose |
| --- | --- |
| `hud shell` | primary plain terminal and context-condenser loop |
| `hud tui` | primary fixed terminal UI over the same shell client |
| `hud desktop` | Windows Repository Map application with trusted terminal capability |
| `hud serve` | local visual client without arbitrary shell-over-HTTP |
| `hud <operation>` | first-class CLI for state, Search, commands, history, handoff, workflows, and Undo |

These clients consume one runtime state and immutable evidence model. Presentation state is not repository authority.

## Interaction contract

- Input and output remain visually distinct and stable.
- Ordinary shell commands remain ordinary commands and preserve exact user intent separately from transport details.
- Long output is reduced deterministically; raw evidence is always reachable.
- Compact output copies automatically in the terminal UI, and explicit copy remains available.
- Running work reports factual running, passed, failed, cancelled, interrupted, stale, or blocked state.
- Cancellation targets only the runtime-owned active operation.
- History is derived from immutable per-project records.
- Search highlights factual matches without inventing dependencies or ownership.
- Undo is a recorded forward operation that reverses a still-applicable worktree delta; it never implies reversal of commits, pushes, or external effects.
- Visual motion is quiet by default and represents observed operations rather than decorative fake activity.

## Capability boundary

A typed capability has a stable identity, inspectable command or primitive, validated inputs, repository boundary, known mutation/effect class, and recorded success or failure evidence. Repository-owned commands are rediscovered by identity at execution time; a browser does not submit arbitrary executable strings to the typed-operation endpoint.

The trusted desktop terminal is deliberately different: it accepts ordinary shell text because direct command execution is the product's primary local workflow. That permission is local to the desktop host and is not exposed by ordinary `hud serve`.

## Authority and portability

- A verified Git root is required for execution.
- Project identity and optional typed commands come from the selected repository.
- Machine-local evidence stays outside Git.
- The generic runtime lives in this product repository, not in every selected project.
- CLI and terminal paths are Node-based and cross-platform where the selected shell exists.
- The current native-feeling desktop host is Windows-only; a packaged signed application remains future work.

## Product restraint

Do not add fake metrics, inferred dependency graphs, decorative process claims, arbitrary shell-over-HTTP, duplicate command catalogs, or a second state/history model. Add a feature when it measurably reduces friction in a real development loop while preserving inspectable computation and evidence.
