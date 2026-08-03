# Order 001 — integrate the existing tool

## Goal

Unify Command HUD v21, DataFactory 0.2.0, and the portable launcher into one repository-focused Windows development utility. Use Digital Breakdown read-only as the first real integration fixture.

## Authority

Work from the current `main` commit of `indrolend/hate.this.meaningless.life`. Inspect all supplied material before changing it. Re-resolve the current default branch and commit of `indrolend/digital-breakdown-apk`; never assume a remembered SHA is current.

## Required implementation

1. Fix portable startup so it opens a verified clone, never Desktop/home/Downloads/current-directory fallback.
2. Default product clone: `%USERPROFILE%\Projects\hate.this.meaningless.life`.
3. Offer `OPEN` and `CLONE` when no project is configured.
4. Persist selected project and validate its `.git` root and origin on every launch.
5. Integrate HUD execution/history behaviors into the extension or a thin companion process without duplicating terminal output.
6. Make history project-specific.
7. Preserve PROJECT, WORK, INSPECT, CHAT and the bounded order/agent-packet implementation.
8. Discover Digital Breakdown's repository-owned status and verification operations without modifying it.
9. Add short dependency states: `READY`, `GIT MISSING`, `AUTH`, `NO PROJECT`, `DIRTY`, `STALE`, `PASS`, `FAIL`.
10. Keep the UI restrained and activity-driven. No fake latency or continuously changing decoration.

## Required tests

- startup cannot select Desktop, user profile, or Downloads implicitly;
- a missing project yields `NO PROJECT`;
- clone destination is deterministic;
- origin mismatch is rejected;
- dirty work is preserved;
- every command executes under the verified root;
- history is isolated per project;
- latest copy differs from all-history copy;
- output is not duplicated;
- orders retain exact authority and evidence requirements;
- Digital Breakdown inspection is read-only;
- packaged portable bootstrap contains the extension and launches without an installed `code` command.

## Prohibited

Do not modify Digital Breakdown, fork VS Code, deploy, publish, merge, force-push, invent cloud services, or replace working repository scripts.

## Delivery

Create a draft PR. Include files changed, commands and exit codes, test results, package hash, observed Digital Breakdown integration state, remaining unknowns, and the next bounded order.
