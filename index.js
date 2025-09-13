// OpenAPI-to-MCP Server (Node.js, single-file)
// - Fetches multiple OpenAPI/Swagger specs at startup
// - Parses operations and exposes each endpoint as an MCP tool
// - Each tool accepts method/path override, path params, query, headers, and body
// - Uses @modelcontextprotocol/sdk (stdio transport)
// - Minimal but production-ready structure, with graceful error handling and in-memory cache

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "url";
import { basename } from "path";

// Polyfill fetch/Headers/Request/Response for older Node versions
async function ensureFetch() {
  if (typeof fetch === "undefined" || typeof Headers === "undefined") {
    const undici = await import("undici");
    // @ts-ignore - set globals if missing
    globalThis.fetch = undici.fetch;
    // @ts-ignore
    globalThis.Headers = undici.Headers;
    // @ts-ignore
    globalThis.Request = undici.Request;
    // @ts-ignore
    globalThis.Response = undici.Response;
  }
}

// -----------------------------
// Utilities
// -----------------------------
const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

/**
 * Normalize a string for use as a tool name segment.
 */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/**
 * Safely join a base URL and a path.
 */
function joinUrl(base, path) {
  if (!base) return path;
  if (!path) return base;
  const hasTrailing = base.endsWith("/");
  const hasLeading = path.startsWith("/");
  if (hasTrailing && hasLeading) return base + path.slice(1);
  if (!hasTrailing && !hasLeading) return base + "/" + path;
  return base + path;
}

/**
 * Replace {param} tokens in a path with encoded values from pathParams.
 */
function fillPathParams(path, pathParams = {}) {
  return path.replace(/\{([^}]+)\}/g, (m, name) => {
    if (!(name in pathParams)) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    const v = pathParams[name];
    return encodeURIComponent(String(v));
  });
}

/**
 * Build a base URL from OpenAPI v3 or Swagger v2 spec.
 */
function resolveBaseUrl(spec) {
  // OpenAPI v3: servers array
  if (spec && Array.isArray(spec.servers) && spec.servers.length > 0) {
    // Ignore server variables for simplicity; take the first url as-is
    const url = spec.servers[0]?.url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  // Swagger v2: schemes + host + basePath
  if (spec && spec.swagger && (spec.host || spec.basePath)) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.length > 0 ? spec.schemes[0] : "https";
    const host = spec.host || "";
    const basePath = spec.basePath || "";
    return `${scheme}://${host}${basePath}`;
  }
  return ""; // allow override via input if needed
}

/**
 * Extract a friendly spec identifier for namespacing tool names.
 */
function getSpecKey(url, spec) {
  const byTitle = spec?.info?.title ? slugify(spec.info.title) : null;
  try {
    const u = new URL(url);
    const byHost = slugify(u.hostname);
    const byPath = slugify(u.pathname.replace(/\/(openapi|swagger)\.(json|yaml|yml)$/i, "").replace(/\//g, "-"));
    const hostPath = byPath ? `${byHost}-${byPath}` : byHost;
    return byTitle || hostPath || slugify(url);
  } catch {
    return byTitle || slugify(url);
  }
}

/**
 * Pretty-print a value as JSON text content.
 */
function asTextContent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

/**
 * Attempt to parse a response as JSON; fallback to text.
 */
async function parseResponse(res) {
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    try {
      const json = await res.json();
      return { kind: "json", value: json };
    } catch {
      // fall through to text
    }
  }
  const text = await res.text();
  return { kind: "text", value: text };
}

/**
 * Build a unique tool name, avoiding collisions.
 */
function makeUniqueName(base, used) {
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base}-${i++}`;
  }
  used.add(name);
  return name;
}

// -----------------------------
// Core: Build server from specs
// -----------------------------
export async function createServer({ urls = [], connect = true } = {}) {
  await ensureFetch();
  const server = new McpServer({ name: "openapi-mcp", version: "0.1.0" });

  // In-memory cache of fetched specs
  const specs = [];

  // Fetch and cache specs (gracefully skip failures)
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const spec = await res.json();
        specs.push({ url, spec, baseUrl: resolveBaseUrl(spec), key: getSpecKey(url, spec) });
      } catch (err) {
        console.error(`[openapi-mcp] Failed to fetch spec ${url}:`, err?.message || err);
      }
    })
  );

  const usedNames = new Set();

  // For each spec, register a tool per operation
  for (const { url: specUrl, spec, baseUrl, key: specKey } of specs) {
    if (!spec?.paths || typeof spec.paths !== "object") {
      console.error(`[openapi-mcp] Spec has no paths: ${specUrl}`);
      continue;
    }

    for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;

      for (const method of METHODS) {
        const op = pathItem[method];
        if (!op) continue;

        const opId = op.operationId ? slugify(op.operationId) : null;
        const methodSlug = method.toUpperCase();
        const pathSlug = slugify(rawPath.replace(/\{([^}]+)\}/g, "$1"));
        const baseName = opId ? `${specKey}.${opId}` : `${specKey}.${methodSlug}.${pathSlug || "root"}`;
        const toolName = makeUniqueName(baseName, usedNames);

        const summary = op.summary || op.description || "";
        const docUrl = spec?.externalDocs?.url || "";
        const defaultDesc = `${methodSlug} ${rawPath} (from ${spec?.info?.title || specKey})`;

        // Define a generic input schema for flexibility across operations
        const inputSchema = {
          baseUrl: z.string().url().optional().describe("Override base URL; defaults to spec's server"),
          method: z.string().optional().describe(`HTTP method; defaults to ${methodSlug}`),
          path: z.string().optional().describe(`Override path; defaults to ${rawPath}`),
          pathParams: z.record(z.string()).optional().describe("Path parameters (name -> value)"),
          query: z.record(z.any()).optional().describe("Query parameters (key -> value | array)"),
          headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
          body: z.any().optional().describe("HTTP request body (JSON serializable)"),
          timeoutMs: z.number().int().positive().max(300000).optional().describe("Request timeout in ms (default 30s)"),
        };

        server.registerTool(
          toolName,
          {
            title: op.summary || op.operationId || defaultDesc,
            description: [
              summary ? summary : defaultDesc,
              `\nSpec: ${spec?.info?.title || specKey}`,
              docUrl ? `\nDocs: ${docUrl}` : "",
              `\nDefault: ${methodSlug} ${rawPath} @ ${baseUrl || "(no base; must override baseUrl)"}`,
            ]
              .filter(Boolean)
              .join(""),
            inputSchema,
          },
          async (
            /** @type {{ baseUrl?: string; method?: string; path?: string; pathParams?: Record<string,string>; query?: Record<string, any>; headers?: Record<string,string>; body?: any; timeoutMs?: number }} */
            { baseUrl: baseUrlOverride, method: methodOverride, path: pathOverride, pathParams, query, headers, body, timeoutMs }
          ) => {
            const finalMethod = (methodOverride || method).toUpperCase();

            const base = baseUrlOverride || baseUrl || "";
            const raw = pathOverride || rawPath;
            let fullPath;
            try {
              fullPath = fillPathParams(raw, pathParams);
            } catch (e) {
              return { content: asTextContent(`Error filling path params: ${e?.message || e}`) };
            }

            // If base is not absolute, constructing URL will fail; handle gracefully
            let finalUrl;
            try {
              finalUrl = new URL(joinUrl(base, fullPath));
            } catch {
              return {
                content: asTextContent(
                  `Invalid URL. Provide a valid baseUrl (current: '${base}') or ensure the path is absolute.`
                ),
              };
            }

            // Apply query
            if (query && typeof query === "object") {
              for (const [k, v] of Object.entries(query)) {
                if (v === undefined || v === null) continue;
                if (Array.isArray(v)) {
                  for (const item of v) finalUrl.searchParams.append(k, String(item));
                } else if (typeof v === "object") {
                  // Encode object as JSON
                  finalUrl.searchParams.set(k, JSON.stringify(v));
                } else {
                  finalUrl.searchParams.set(k, String(v));
                }
              }
            }

            // Build headers
            const hdrs = new Headers();
            hdrs.set("Accept", "application/json, */*;q=0.8");
            if (headers && typeof headers === "object") {
              for (const [k, v] of Object.entries(headers)) {
                if (v != null) hdrs.set(k, String(v));
              }
            }

            // Prepare body
            let fetchBody = undefined;
            if (body != null && finalMethod !== "GET" && finalMethod !== "HEAD") {
              const explicitType = hdrs.get("content-type");
              if (!explicitType) hdrs.set("content-type", "application/json");
              if ((hdrs.get("content-type") || "").includes("application/json")) {
                fetchBody = typeof body === "string" ? body : JSON.stringify(body);
              } else {
                // If user provided a different content-type, assume body is string or Buffer-compatible
                fetchBody = body;
              }
            }

            const controller = new AbortController();
            const to = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs || 30000, 1), 300000));

            let res;
            try {
              res = await fetch(finalUrl, {
                method: finalMethod,
                headers: hdrs,
                body: fetchBody,
                signal: controller.signal,
              });
            } catch (e) {
              clearTimeout(to);
              return { content: asTextContent(`Request failed: ${e?.message || e}`) };
            }
            clearTimeout(to);

            const parsed = await parseResponse(res);
            const info = {
              status: res.status,
              statusText: res.statusText,
              url: res.url,
              ok: res.ok,
              headers: Object.fromEntries(res.headers.entries()),
              body: parsed.value,
            };

            return {
              content: asTextContent(info),
            };
          }
        );
      }
    }
  }

  // Optionally connect the server to stdio
  if (connect) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  return server;
}

// -----------------------------
// Bootstrap (read configuration, start server)
// -----------------------------
function parseUrlsFromEnvAndArgs() {
  const envUrls = (process.env.OPENAPI_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Accept CLI args that look like URLs
  const argUrls = process.argv
    .slice(2)
    .filter((s) => /^(https?:)?\/\//i.test(s));
  // De-dupe while preserving order
  const seen = new Set();
  const out = [];
  for (const u of [...envUrls, ...argUrls]) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

async function main() {
  await ensureFetch();
  const urls = parseUrlsFromEnvAndArgs();
  if (urls.length === 0) {
    console.error(
      "[openapi-mcp] No OpenAPI URLs provided. Set OPENAPI_URLS or pass URLs as CLI args."
    );
  } else {
    console.error(`[openapi-mcp] Loading ${urls.length} OpenAPI spec(s)...`);
  }
  await createServer({ urls, connect: true });
}

// Only run main when executed as a script (avoid auto-start on import)
const isMain = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? basename(process.argv[1]) : "";
    return basename(thisFile) === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("[openapi-mcp] Fatal error:", err);
    process.exit(1);
  });
}
