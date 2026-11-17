# partfits

Looking for the right battery, screen or keyboard for a laptop should not mean guessing a part number and hoping. partfits is a small forwarding client for the hosted Laptop Part Finder service: the tool list is served from your own machine using the captured definitions, and each call is sent upstream, with the service's answer returned exactly as it arrived.

All six of the service's captured tools are exposed. You can search the OEM parts catalogue by free text, browse the models the catalogue covers, pull every documented part for one model, look up a part number and see every model it fits, and find and read step-by-step replacement guides drawn from official service manuals. Every tool only reads; the tools return source URLs, and nothing is ordered, quoted or submitted anywhere.

## The tools

- **`search_parts`** — Search OEM replacement parts and laptop models by free text (a model name, a part number, or a part type such as battery or screen) via `query`. Returns part numbers with the official source URL for each fit. An optional `type` filter and a `limit` (1 to 50) narrow the result.
- **`list_models`** — List the laptop and Chromebook models the catalogue covers. Optional `brand` and `category` (`chromebook` or `business-laptop`) filters narrow the list. No required fields.
- **`get_model_parts`** — Get every documented OEM replacement part for one laptop model via `model` (a slug such as `lenovo-thinkpad-t490` or a plain name). Ambiguous names return candidate models instead of a guess. An optional `client` name attributes outbound affiliate links.
- **`get_part_fits`** — Look up an OEM `part_number` and list every laptop model it is documented to fit, with the official source URL for each fit. An optional `client` name works the same way as above.
- **`find_repair_guides`** — Find step-by-step replacement guides (battery, SSD, RAM, keyboard, fan, speakers, RTC battery, WLAN and more) paraphrased from official service manuals. Filter by `model`, `component` or free-text `query`; topics not yet covered are listed too. No required fields.
- **`get_repair_guide`** — Read one guide by its `slug`: full Markdown steps with page citations, the official manual URL, HP service classification and scope restrictions.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/partfits mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "partfits": {
      "command": "npx",
      "args": ["-y", "@reneturcios/partfits", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/partfits
docker run --rm ghcr.io/cloudcorprecords/partfits search_parts '{"query":"ThinkPad T490 battery"}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
partfits search_parts '{"query":"ThinkPad T490 battery"}'
partfits list_models '{"brand":"Lenovo"}'
partfits get_model_parts '{"model":"lenovo-thinkpad-t490"}'
partfits get_part_fits '{"part_number":"L18M3PF1"}'
partfits find_repair_guides '{"component":"battery"}'
partfits get_repair_guide '{"slug":"hp-elitebook-840-g6-battery-replacement"}'
partfits --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse.

## Configuration

- `LAPTOPPARTFINDER_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://laptoppartfinder.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Laptop Part Finder registry record lists no headers for its remote, so partfits never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `partfits error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, partfits repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, walks the session handshake and its reuse, proves no `Authorization` header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
