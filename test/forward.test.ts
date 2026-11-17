import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  PartfitsClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Laptop Part Finder endpoint
 * is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/laptoppartfinder-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
/**
 * Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (extended fleet-wide 2026-11-15): the served tools carry
 * parameter descriptions added over the original capture; everything
 * else must match the fixture exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SEARCH = "search_parts";
const LIST = "list_models";
const MODEL_PARTS = "get_model_parts";
const PART_FITS = "get_part_fits";
const FIND_GUIDES = "find_repair_guides";
const GET_GUIDE = "get_repair_guide";
const ALL_TOOLS = [SEARCH, LIST, MODEL_PARTS, PART_FITS, FIND_GUIDES, GET_GUIDE];

const SAMPLE_RESULT = {
  content: [
    { type: "text", text: "ThinkPad T490 battery — part L18M3PF1." },
  ],
  structuredContent: { part_number: "L18M3PF1" },
};

const SEARCH_ARGS = { query: "ThinkPad T490 battery" };
const MODEL_ARGS = { model: "lenovo-thinkpad-t490" };
const FITS_ARGS = { part_number: "L18M3PF1" };
const GUIDE_ARGS = { slug: "hp-elitebook-840-g6-battery-replacement" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "laptop-part-finder", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new PartfitsClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "partfits-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 6 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 6);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 6 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (name, title, description, inputSchema)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(defOf(SEARCH).title, "Search laptop parts");
    assert.equal(defOf(LIST).title, "List laptop models");
    assert.equal(defOf(MODEL_PARTS).title, "Get parts for a model");
    assert.equal(defOf(PART_FITS).title, "Get models a part fits");
    assert.equal(defOf(FIND_GUIDES).title, "Find repair guides");
    assert.equal(defOf(GET_GUIDE).title, "Get a repair guide");
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
    }
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(SEARCH).description, /official source URL/);
    assert.match(defOf(MODEL_PARTS).description, /ambiguous/);
    assert.match(defOf(FIND_GUIDES).description, /not bench-tested|not yet covered/);
    assert.match(defOf(GET_GUIDE).description, /Not bench-tested/);
  });

  it("search_parts requires exactly query; get_model_parts requires exactly model", () => {
    assert.deepEqual(schemaOf(defOf(SEARCH)).required, ["query"]);
    assert.deepEqual(schemaOf(defOf(MODEL_PARTS)).required, ["model"]);
  });

  it("get_part_fits requires exactly part_number; get_repair_guide requires exactly slug", () => {
    assert.deepEqual(schemaOf(defOf(PART_FITS)).required, ["part_number"]);
    assert.deepEqual(schemaOf(defOf(GET_GUIDE)).required, ["slug"]);
  });

  it("list_models and find_repair_guides carry NO required key (served verbatim)", () => {
    assert.equal("required" in schemaOf(defOf(LIST)), false);
    assert.equal(schemaOf(defOf(LIST)).required, undefined);
    assert.equal("required" in schemaOf(defOf(FIND_GUIDES)), false);
    assert.equal(schemaOf(defOf(FIND_GUIDES)).required, undefined);
  });

  it("every inputSchema is an object schema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("search_parts carries query, type, limit in order with the captured constraints", () => {
    const props = schemaOf(defOf(SEARCH)).properties;
    assert.deepEqual(Object.keys(props), ["query", "type", "limit"]);
    assert.equal(props.query.type, "string");
    assert.equal(props.type.type, "string");
    assert.equal(props.limit.type, "integer");
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 50);
  });

  it("list_models carries brand then category with the captured enum", () => {
    const props = schemaOf(defOf(LIST)).properties;
    assert.deepEqual(Object.keys(props), ["brand", "category"]);
    assert.equal(props.brand.type, "string");
    assert.deepEqual(props.category.enum, ["chromebook", "business-laptop"]);
  });

  it("get_model_parts and get_part_fits carry the optional client alongside their required field", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(MODEL_PARTS)).properties), ["model", "client"]);
    assert.deepEqual(Object.keys(schemaOf(defOf(PART_FITS)).properties), ["part_number", "client"]);
  });

  it("find_repair_guides carries model, component, query in order", () => {
    const props = schemaOf(defOf(FIND_GUIDES)).properties;
    assert.deepEqual(Object.keys(props), ["model", "component", "query"]);
  });

  it("get_repair_guide carries only slug", () => {
    const props = schemaOf(defOf(GET_GUIDE)).properties;
    assert.deepEqual(Object.keys(props), ["slug"]);
    assert.equal(props.slug.type, "string");
  });

  it("isKnownTool recognises all built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("search"), false);
    assert.equal(isKnownTool("list"), false);
    assert.equal(isKnownTool(""), false);
  });

  it("the MCP tools/list response deep-equals the fixture's 6 tools", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    assert.deepEqual(stripDescriptions(listed), stripDescriptions(fixture.tools));
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://laptoppartfinder.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name partfits and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SEARCH_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "partfits", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SEARCH_ARGS);
    await c.callTool(LIST, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LAPTOPPARTFINDER_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new PartfitsClient({
      fetchFn: upstream.fetchFn,
      env: { LAPTOPPARTFINDER_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LAPTOPPARTFINDER_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new PartfitsClient({
      fetchFn: upstream.fetchFn,
      env: { LAPTOPPARTFINDER_MCP_URL: "   " },
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LAPTOPPARTFINDER_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new PartfitsClient({
      fetchFn: upstream.fetchFn,
      env: { LAPTOPPARTFINDER_API_KEY: "some-key-42" },
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new PartfitsClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        LAPTOPPARTFINDER_TOKEN: "z",
      },
    });
    await c.callTool(LIST, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new PartfitsClient({
      fetchFn: upstream.fetchFn,
      env: { LAPTOPPARTFINDER_API_KEY: "some-key-42" },
    });
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SEARCH_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a search_parts call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SEARCH_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, SEARCH_ARGS);
  });

  it("forwards a search_parts call with type and limit verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { query: "battery", type: "Battery", limit: 10 };
    await c.callTool(SEARCH, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, args);
  });

  it("forwards list_models under its own name with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(LIST, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, LIST);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards list_models with brand and category verbatim", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const args = { brand: "Lenovo", category: "business-laptop" };
    await c.callTool(LIST, args);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, args);
  });

  it("forwards get_model_parts under its own name with its model", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(MODEL_PARTS, MODEL_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, MODEL_PARTS);
    assert.deepEqual(params.arguments, MODEL_ARGS);
  });

  it("forwards get_part_fits under its own name with its part_number", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(PART_FITS, FITS_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PART_FITS);
    assert.deepEqual(params.arguments, FITS_ARGS);
  });

  it("forwards find_repair_guides under its own name", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const args = { model: "hp-elitebook-840-g6", component: "battery" };
    await c.callTool(FIND_GUIDES, args);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, FIND_GUIDES);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards get_repair_guide under its own name with its slug", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(GET_GUIDE, GUIDE_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GET_GUIDE);
    assert.deepEqual(params.arguments, GUIDE_ARGS);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such part upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(SEARCH, { query: "nowhere" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(GET_GUIDE, GUIDE_ARGS, {
      fetchFn: upstream.fetchFn,
      env: {},
    });
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GET_GUIDE);
    assert.deepEqual(params.arguments, GUIDE_ARGS);
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as partfits error text", () => {
  it("maps a JSON-RPC error to `partfits error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "part lookup failed upstream" },
    });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: part lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to partfits error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: malformed response");
  });

  it("maps a non-2xx upstream status to partfits error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: HTTP 500");
  });

  it("maps a throwing fetch to partfits error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^partfits error: /);
  });

  it("maps a throwing initialize fetch to partfits error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "partfits error: socket hang up");
  });

  it("maps a timed-out call to partfits error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(SEARCH, SEARCH_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^partfits error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, "query=battery"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search_parts call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH, SEARCH_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SEARCH_ARGS);
  });

  it("forwards a valid get_repair_guide call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, GET_GUIDE, GUIDE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GET_GUIDE);
    assert.deepEqual(params.arguments, GUIDE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, LIST, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });

  it("an MCP tools/call forwards through to the upstream", async () => {
    const upstream = makeUpstream();
    const res = await withMcpClient(upstream, async (client) => {
      return client.callTool({ name: SEARCH, arguments: SEARCH_ARGS });
    });
    assert.deepEqual(res, SAMPLE_RESULT);
    assert.equal(upstream.calls.length, 3);
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /search_parts, list_models, get_model_parts, get_part_fits, find_repair_guides, get_repair_guide/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([SEARCH, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([SEARCH, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
