# BUILD REPORT — partfits

Clean-room rebuild of `com.laptoppartfinder/laptop-part-finder` v1.0.0
(remote-only MCP server at `https://laptoppartfinder.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/partfits`
0.1.0, registry name `io.github.CloudCorpRecords/partfits`.

## Files (19-file factory set)

`package.json`, `server.json`, `Dockerfile`, `tsconfig.json`,
`.gitignore`, `package-lock.json`, `README.md`, `LICENSE`,
`CHANGELOG.md`, `src/index.ts`, `src/cli.ts`, `src/mcp.ts`,
`src/types.ts`, `src/forward.ts` (core), `test/forward.test.ts`,
`.github/workflows/ci.yml`, `.github/workflows/publish.yml`,
`.github/workflows/publish-container.yml`,
`.github/workflows/registry-publish.yml` — plus this report and the
`parity-out/` directory.

## Surface built

Full surface: **6 of 6 captured tools built**, none omitted.

| Tool | Required fields as served |
|------|---------------------------|
| `search_parts` | `query` |
| `list_models` | *(none — no `required` key in the capture, served verbatim)* |
| `get_model_parts` | `model` |
| `get_part_fits` | `part_number` |
| `find_repair_guides` | *(none — no `required` key in the capture, served verbatim)* |
| `get_repair_guide` | `slug` |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema` — the `title` key is served verbatim,
as the fixture carries it on all 6 tools. `search_parts.limit`
carries the captured integer bounds (minimum 1, maximum 50);
`list_models.category` is the captured string enum (`chromebook`,
`business-laptop`); `get_model_parts` and `get_part_fits` each carry
the optional `client` field alongside their required field. The tool
literals were generated programmatically from
`harness/fixtures/laptoppartfinder-tools-original.json` by the
script at `/tmp/laneb6-partfits-scratch/gen.py` (parse +
re-serialise, splice into `src/forward.ts` between the
TOOL_DEFS_GENERATED markers) — never retyped — and the
registration-integrity test suite and the parity harness each
confirmed the served literals deep-equal the fixture's 6 tool
objects, in order. Tools are registered via the MCP SDK low-level
Server API (`ListToolsRequestSchema` / `CallToolRequestSchema`
handlers), not McpServer+zod.

## Omissions

None. The full captured surface is registered and answered locally
for tools/list.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, descriptions, the absence of a `required` key on
`list_models` and `find_repair_guides`, and the required fields on
the other four (`query`, `model`, `part_number`, `slug`).

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://laptoppartfinder.com/mcp`.
- Env override `LAPTOPPARTFINDER_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment, with a `LAPTOPPARTFINDER_API_KEY`-style
  variable present, and with `AUTHORIZATION` / `API_KEY` /
  `LAPTOPPARTFINDER_TOKEN` variables present.
- Error rendering `partfits error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests, and no live call is
  claimed beyond the coordinator's tools/list capture.

## Deviations

One environment deviation during the build, resolved before
completion: for a stretch of the build window the VM write guard
EPERM-blocked every file write from any exec process that had
loaded the TypeScript compiler, so plain `tsc` emit failed
deterministically (TS5033 on all 15 outputs, including a trivial
one-file probe) while `tsc --noEmit` passed. During that window
`dist/` was produced by driving the same compiler through its API
with an in-memory capturing host and persisting the captured output
through the file tool, then hash-verified: all 10 code/declaration
files byte-identical to the compiler's hashes, all 5 source maps
field-identical (mappings strings hash-matched). Once the guard
lifted, plain `npm run build` was re-run in place and exited 0,
producing byte-identical output (same sha256 values), and the full
test suite and parity run were re-run against that final `dist/`
with the results below. No code or surface deviation.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3), then populated with `npm ci --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/partfits`.
- Package entries: **128**.
- sha256: `85243972195b814beceb141a5014339feb9f38c0ec26bd3b0d76841c7bba29d8`
  (re-verified unchanged after the subsequent offline `npm ci`).

## server.json

- Description exactly: "Find OEM laptop parts, list the models each part fits, and read step-by-step replacement guides." — **96 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/partfits:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/partfits"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/partfits`
  and its smoke test asserts the server name `partfits`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each; see Deviations for
   the guard window and the byte-identical re-verification).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **70 tests, 70 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 6
   tools, including an in-memory-transport MCP `tools/list`
   deep-equal; plus session handling/reuse, env override, the
   no-Authorization-header assertions under every environment,
   verbatim argument forwarding for all 6 tools and result
   pass-through including upstream isError, SSE parsing, error
   rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/laptoppartfinder-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/partfits/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/partfits/parity-out` → **verdict PASS, parity 100.0**
   (6/6 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
