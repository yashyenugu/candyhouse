# CLAUDE.md

Read and follow @AGENTS.md for architecture, service boundaries, how to run things locally, and testing. Everything there applies.

## Working rules (do not skip)

- **Never commit to `main`.** Start by creating a branch: `fix/...`, `feat/...`, or `chore/...`.
- When the change is ready, open a pull request with `gh pr create` and then **stop**. Do not merge. The human reviews and merges.
- Before you say a task is done, run `yarn tsc --noEmit`, `yarn lint`, and `yarn test` in each service you touched, and paste the results into your summary.
- Keep each PR to one logical change. If the task grows, split it.
- Respect the service boundaries in AGENTS.md: no service touches another service's database; cross-service changes go over Kafka or HTTP.
- Never commit secrets or `.env*` files.

## Good first prompt shape

State the goal, the service and files in scope, what is off-limits, and what "done" means (tests pass, lint and types clean). Then let me propose a plan before I write code.
