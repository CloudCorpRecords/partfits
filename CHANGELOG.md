# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Laptop Part Finder MCP server. All six captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `search_parts`, `list_models`, `get_model_parts`, `get_part_fits`, `find_repair_guides`, `get_repair_guide`. Every tool is a catalogue or guide read; nothing is ordered, quoted or submitted anywhere in the surface.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `partfits error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LAPTOPPARTFINDER_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
