# Contributing

Thanks for your interest in `@blen/clinicaltrial-mcp-server`.

## Local setup

```bash
pnpm install            # builds isolated-vm via node-gyp (or uses prebuild)
pnpm typecheck
pnpm test
pnpm dev                # runs stdio transport for local Claude Desktop testing
```

If `pnpm test` reports `No sandbox executor available`, install one of:

- **Deno** (easiest): `brew install deno` or
  `curl -fsSL https://deno.land/install.sh | sh` — the tests auto-detect it.
- **isolated-vm build toolchain**: `xcode-select --install` on macOS, or
  `sudo apt-get install -y build-essential python3` on Debian/Ubuntu, then
  `pnpm rebuild isolated-vm`.

Sandbox-requiring specs skip gracefully when neither is present so the rest
of the suite stays green.

To run the HTTP transport with the built-in embedded AS:

```bash
export CTGOV_AUTH_PROVIDER=embedded
export CTGOV_AUTH_ISSUER=http://127.0.0.1:8080
export CTGOV_AUTH_RESOURCE=http://127.0.0.1:8080/mcp
export CTGOV_EMBEDDED_USERS=alice:wonderland
pnpm build && node dist/bin.js --http --port 8080
```

## Conventions

- TypeScript strict, `exactOptionalPropertyTypes`.
- No default exports; no namespace imports from Node (`node:`).
- `dist/` is build output only — never hand-edit.
- All new MCP tool handlers MUST validate inputs with zod.
- All sandbox-facing types must also be emitted in `src/sdk/generated.d.ts`
  (regenerate via `pnpm regen:sdk` when the upstream schema changes).

## Tests

- `test/*.spec.ts` runs under vitest. Keep tests hermetic: either
  `undici.MockAgent` for HTTP, `nock`-style setup, or a local JWKS server
  for OAuth flows.
- Sandbox tests use `selectSandbox({ mode: "isolate" })`; Deno tests are
  skipped automatically when `deno` is not on PATH.

## Commit style

Present tense imperative, one sentence scope:

> `feat: add embedded authorization server for self-hosts`

## License

By contributing, you agree your contribution is licensed under the MIT
license alongside the rest of the project.
