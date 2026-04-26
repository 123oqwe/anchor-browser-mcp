#!/usr/bin/env node
/**
 * anchor-browser-mcp — cross-platform browser-history reader as MCP server.
 *
 * Speaks MCP 2025-06-18 over stdio. Reads Chromium (Chrome/Brave/Edge/Arc)
 * + Firefox + Safari sqlite history files directly. Per-OS path table.
 *
 * Tools:
 *   browser_recent_visits  — top URLs by visit count, last N days
 *   browser_top_domains    — aggregated domain visit counts
 *   browser_search         — keyword search across URL + title
 *   browser_status         — platform + detected browser profiles
 *
 * Read-only. Sensitive domains (banking / health / auth / adult) blocked at
 * source. No network calls. No telemetry.
 */
import { recentVisits, topDomains, searchHistory, status } from "./browser-history.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "anchor-browser-mcp", version: "0.1.0" };

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: any; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: "browser_recent_visits",
    description: "Top URLs visited recently across all detected browsers. Sensitive domains (banking, health, auth) blocked.",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: { type: "number", description: "How many days back (default 30)" },
        limit: { type: "number", description: "Max URLs (default 200, max 1000)" },
      },
    },
  },
  {
    name: "browser_top_domains",
    description: "Aggregated domain visit counts.",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: { type: "number", description: "default 30" },
        limit: { type: "number", description: "Max domains (default 30)" },
      },
    },
  },
  {
    name: "browser_search",
    description: "Keyword search across browser history (URL + title). Useful for the agent to find a specific page the user remembers visiting.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search" },
        sinceDays: { type: "number", description: "default 90" },
        limit: { type: "number", description: "default 30" },
      },
      required: ["query"],
    },
  },
  {
    name: "browser_status",
    description: "Platform + detected browser profiles + blocked-domain count.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "browser_recent_visits":
      return JSON.stringify(recentVisits({ sinceDays: args.sinceDays, limit: args.limit }), null, 2);
    case "browser_top_domains":
      return JSON.stringify(topDomains({ sinceDays: args.sinceDays, limit: args.limit }), null, 2);
    case "browser_search":
      if (!args.query) throw new Error("query required");
      return JSON.stringify(searchHistory(String(args.query), { sinceDays: args.sinceDays, limit: args.limit }), null, 2);
    case "browser_status":
      return JSON.stringify(status(), null, 2);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? 0;
  if (req.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (req.method === "notifications/initialized") return null;
  if (req.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (req.method === "tools/call") {
    const { name, arguments: args } = req.params ?? {};
    try {
      const text = await callTool(name, args ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async chunk => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const req: JsonRpcRequest = JSON.parse(line);
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err: any) {
      process.stderr.write(`[parse-error] ${err?.message ?? err}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.stderr.write(`[anchor-browser-mcp] ready on stdio (platform=${process.platform})\n`);
