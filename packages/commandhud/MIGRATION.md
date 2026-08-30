# CommandHUD convergence baseline (historical)

This document records the import-time migration boundary. Its temporary instruction to retain a copied DATA runtime has been completed and is no longer current policy. `AGENTS.md`, `docs/ARCHITECTURE.md`, and `docs/MATERIAL-INVENTORY.md` define present authority: `packages/commandhud/` is canonical and selected projects must not carry copied generic runtimes.

This directory was imported with preserved `tools/hud` history from the newest observed DATA HUD authority, local branch `agent/playground-physical-traversal` at `068097c`, using a subtree split at `f9515cd`.

The import checkpoint was intentionally behavior-preserving. The current convergence branch now:

- verifies any real Git repository and accepts explicit or inferred identity;
- retains DATA's legacy manifest format as a compatible identity source;
- provides product-owned root launchers and a tested cross-checkout shell path;
- reads additional typed commands from the selected repository's manifest instead of owning DATA command filenames;
- carries selected project identity through repository currency instead of labeling generic evidence as DATA;
- reads project success markers and generic semantic kinds instead of owning DATA reducer patterns.

Do not delete the DATA copy or replace the legacy bridge until product installation and DATA adapter parity are proven from a clean clone. The next bounded checkpoint is a clean-clone parity test, followed by replacing DATA's copied runtime with configuration and thin launchers.
