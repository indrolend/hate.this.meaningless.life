# Product contract

## User outcome

Open one project, see its real state, state an intention, run or delegate bounded work, inspect evidence, and recover the history without navigating an IDE maze.

## Views

| View | Owns |
| --- | --- |
| PROJECT | verified root, origin, branch, commit, dirty state, dependencies |
| WORK | current and previous orders |
| INSPECT | latest output, evidence, diff, failure, runtime state |
| CHAT | free exploration and deterministic goal creation |

## Verbs

`OPEN` `CLONE` `RUN` `TEST` `CHANGE` `UNDO` `SUMMON` `EXPORT`

This iteration only needs the verbs required for one end-to-end path. Do not add disabled decorative controls.

## Command HUD behavior to preserve

- OUTPUT and INPUT are visually distinct.
- Enter runs; Shift+Enter inserts a line.
- RUN executes asynchronously; STOP cancels.
- LIVE opens active output.
- COPY copies latest output only.
- ALL copies command/output history for the active project.
- Clicking OUTPUT copies it.
- Clicking empty INPUT pastes new clipboard text; auto-run is an explicit setting.
- Mouse wheel traverses command history.
- Output prints once.
- History persists per project and session.
- The face reports ready, running, passed, failed, stopped, copied, dirty, stale, or missing dependency.

## Order

An order records intent, authority, constraints, required evidence, status, and timestamps. Creating an order does not automatically summon an external agent.

## Capability

A capability is a reusable operation with declared inputs, outputs, working directory, mutations, external effects, and success/failure evidence. It is more than a shell alias.
