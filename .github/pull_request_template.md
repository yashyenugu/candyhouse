## What and why

<!-- One or two sentences: what this changes and the reason. -->

## Service(s) touched

<!-- user-service / product-service / order-service / store-ui / infra -->

## How I verified

<!-- Commands run and their result. -->

- [ ] `yarn tsc --noEmit` passes in each service touched
- [ ] `yarn lint` passes (where a lint script exists)
- [ ] `yarn test` passes / tests added for the change
- [ ] No secrets or `.env*` committed
- [ ] Scoped to one logical change
- [ ] Respects service boundaries (no cross-service DB access)
