## What

<!-- One paragraph: the change and its motivation. Link issues. -->

## How

<!-- Implementation notes for a reviewer. Highlight non-obvious decisions. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] If the portal (`web/`) or docs site (`site/`) changed: `pnpm test:web` passes, and the manual checks in `docs/accessibility.md` were repeated for the changed pages
- [ ] If a portal kit file changed: `pnpm kit:update`, and a follow-up to copy the kit to the other servers
- [ ] If HTTP-visible: added/updated a case in `test/http-integration.spec.ts`
- [ ] If sandbox-visible: added a positive and a negative case in `test/sandbox.spec.ts` (both runners)
- [ ] If new SDK method: added an endpoint entry with a runnable example in `schema/ctgov.json`, registered it in the `methods` table of `src/sdk/sources/ctgov.ts`, added it to `test/dispatch.spec.ts`, and ran `node scripts/gen-sdk-reference.mjs`
- [ ] If it changes upstream calls: ran `CTGOV_LIVE=1 pnpm test` (or explained why not)
- [ ] No tokens, `.env` files or secrets in the diff

## Risk

<!-- Security/perf/back-compat impact. "None" is a valid answer when honest. -->
