# CommandHUD convergence baseline

This directory was imported with preserved `tools/hud` history from the newest observed DATA HUD authority, local branch `agent/playground-physical-traversal` at `068097c`, using a subtree split at `f9515cd`.

This first checkpoint is intentionally behavior-preserving rather than generic. The core still:

- requires `distribution/project.json` with `id: indrolend/data`;
- includes DATA-specific discovered commands and reducer patterns;
- contains a DATA-specific root launcher test, skipped here until the generic project contract and product launcher exist.

Do not delete the DATA copy or replace the legacy bridge yet. The next bounded checkpoint is to introduce a generic project identity/configuration contract, move DATA command/reducer knowledge behind a DATA adapter, and run the same suite against both generic fixtures and the real DATA repository.
