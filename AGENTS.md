# AGENTS.md

How work lands in bb-plugin-usage.

## Branch

- Base and target branch: `dev/copilot-enterprise-limits`, **not** `main`. The installed plugin tracks that branch.
- New worktrees start from `origin/main`. Reset to the dev branch before you start:
  `git fetch origin && git reset --hard origin/dev/copilot-enterprise-limits`

## Checks

Read `package.json` for the current commands. At the time of writing:

- Typecheck: `npm run check`
- Tests: `npm test` (also verifies that `lib/host-scripts.generated.ts` is up to date; regenerate with `npm run generate:collectors`)
- Build: `npm run build`

## Landing

1. Bump `version` in `package.json` when the change should reach the installed plugin. Docs-only changes don't need a bump.
2. Commit to `dev/copilot-enterprise-limits` and push it: `git push origin HEAD:dev/copilot-enterprise-limits`
3. Run `bb plugin update usage --yes`, then check the change live in bb.
4. Record it: `bb ultimate landed --summary "<what shipped>" [--commits <n>] [--url <commit URL>]`

## Fragile spot: composer footer

The live session footer is portaled into bb's own composer DOM. bb has no slot for it. Every bb selector the plugin depends on is in `lib/composer-footer-anchor.ts`. After a bb upgrade, compare those selectors with bb's current footer markup and confirm that the footer still renders beside the context gauge.
