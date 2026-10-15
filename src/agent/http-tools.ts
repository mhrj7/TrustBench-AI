import { readFileSync } from "node:fs";
import type { AgentToolRegistry, ToolExecutionResult } from "./contracts.ts";

// The registered tool set is the argument-schema manifest exported from configs/policy.yaml (scripts/export-capabilities.py).
const manifestPath = new URL("../policy/capability-manifests.json", import.meta.url);
const toolNames: string[] = Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).argument_schemas);

export interface HttpToolRegistryOptions {
  baseUrl: string;
  episodeId: string;
  fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
}

export class ToolServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Tool service rejected the call with ${status}: ${code}`);
    this.name = "ToolServiceError";
    this.status = status;
    this.code = code;
  }
}

function loopbackBaseUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Tool service base URL must be loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

export function createHttpToolRegistry(options: HttpToolRegistryOptions): AgentToolRegistry {
  const base = loopbackBaseUrl(options.baseUrl);
  const basePath = base.pathname === "/" ? "" : base.pathname;
  const fetchImpl = options.fetchImpl ?? fetch;
  return Object.fromEntries(toolNames.map((toolName) => [toolName, {
    async execute(argumentsValue, context): Promise<ToolExecutionResult> {
      const url = new URL(`${basePath}/v1/episodes/${encodeURIComponent(options.episodeId)}/tools/${toolName}`, base.origin);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(argumentsValue),
        signal: context.signal,
      });
      const body = await response.json() as unknown;
      if (!response.ok) {
        const detail = body !== null && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string"
          ? (body as { detail: string }).detail : "tool_service_error";
        throw new ToolServiceError(response.status, detail);
      }
      return { output: body, stateChangeIds: [] };
    },
  }])) as AgentToolRegistry;
}
