# CommandHUD convergence baseline

This directory was imported with preserved `tools/hud` history from the newest observed DATA HUD authority, local branch `agent/playground-physical-traversal` at `068097c`, using a subtree split at `f9515cd`.

The import checkpoint was intentionally behavior-preserving. The current convergence branch now:

- verifies any real Git repository and accepts explicit or inferred identity;
- retains DATA's legacy manifest format as a compatible identity source;
- provides product-owned root launchers and a tested cross-checkout shell path;
- reads additional typed commands from the selected repository's manifest instead of owning DATA command filenames;
- still includes a few DATA-oriented output reducer patterns that need a later semantic adapter boundary.

Do not delete the DATA copy or replace the legacy bridge until product installation and DATA adapter parity are proven from a clean clone. The next bounded checkpoint is to move remaining DATA reducer knowledge behind a semantic adapter, then replace DATA's copied runtime with configuration and adapters.
