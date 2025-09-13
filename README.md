# OpenAPI → MCP Server (Node.js)

A minimal, production-ready MCP server that fetches multiple OpenAPI/Swagger specs at startup and exposes each endpoint as an MCP tool.

- Input: a list of OpenAPI/Swagger JSON URLs (via ENV or CLI).
- On start: fetch all specs, cache in memory, parse operations, and register one MCP tool per endpoint.
- Each tool lets you call the endpoint with method, path, path params, query, headers, and body.
- Output: returns the full HTTP response shape (status, headers, and parsed body) as JSON text.

## Quick start

Prereqs: Node.js 18.17+ (or 20+ recommended).

```bash
# 1) Install dependencies
npm install

# 2) Run with multiple OpenAPI URLs
OPENAPI_URLS="http://service1/swagger/v1/swagger.json,http://service2/swagger/v1/swagger.json" \
node index.js
```

You can also pass URLs as CLI args:

```bash
node index.js https://petstore3.swagger.io/api/v3/openapi.json https://demo.swagger.io/v2/swagger.json
```

## What gets registered

- For each operation in each spec, a tool is registered.
- Tool name format: `<spec-key>.<operationId>` if available, otherwise `<spec-key>.<METHOD>.<path>` (path placeholders normalized).
- Description includes the default method/path and the inferred base URL from the spec.

Example call shape (inputs accepted by any tool):
- baseUrl: string (optional) – override base URL if spec has none or you want a different host.
- method: string (optional) – override HTTP method (defaults to the operation's method).
- path: string (optional) – override path (defaults to the operation's path in the spec).
- pathParams: record<string,string> – values to replace {param} tokens in the path.
- query: record<string, any> – query parameters; arrays are repeated, objects are JSON-encoded.
- headers: record<string,string> – any extra headers (e.g. Authorization).
- body: any – request body (JSON by default; override content-type header to send raw strings or other formats).
- timeoutMs: number – request timeout (default 30s, max 5m).

Response content: a single text item containing JSON like:

```json
{
  "status": 200,
  "statusText": "OK",
  "url": "https://api.example.com/v1/items",
  "ok": true,
  "headers": { "content-type": "application/json" },
  "body": { "id": 1, "name": "Example" }
}
```

## Configuration

- ENV variable: `OPENAPI_URLS` – comma-separated list of OpenAPI/Swagger JSON URLs.
- CLI args: any argument matching a URL (`http(s)://...`) will be treated as a spec URL.
- Both sources are merged in order with de-duplication.

Examples:

```bash
# ENV only
OPENAPI_URLS="https://petstore3.swagger.io/api/v3/openapi.json,https://demo.swagger.io/v2/swagger.json" \
node index.js

# CLI only
node index.js https://petstore3.swagger.io/api/v3/openapi.json

# Mixed (ENV first, then CLI)
OPENAPI_URLS="https://demo.swagger.io/v2/swagger.json" \
node index.js https://petstore3.swagger.io/api/v3/openapi.json
```

## Error handling

- If a spec URL fails to fetch or parse, it’s logged and skipped; other specs still load.
- Invalid/missing pathParams produce a clear error.
- Non-absolute base URLs return a clear error suggesting to set `baseUrl`.
- Request timeouts are enforced (default 30s).

## Connect this MCP server to clients

This server uses MCP stdio transport. Point your client at:
- Command: `node`
- Args: `["index.js"]`
- Environment: set `OPENAPI_URLS` as needed.

### ChatGPT (Custom GPT with MCP)

- Create or edit your Custom GPT.
- Go to Configure → Tools → Add Tool → Model Context Protocol.
- Choose “Stdio”.
- Command: `node`
- Arguments: `index.js`
- Environment Variables:
  - `OPENAPI_URLS` = `https://petstore3.swagger.io/api/v3/openapi.json`
- Save and start chatting. The GPT will list tools dynamically generated from the spec.

### GitHub Copilot Workspace

Create a `.copilot/workspace/mcp.json` (or use the UI config) with:

```json
{
  "mcpServers": {
    "openapi": {
      "command": "node",
      "args": ["index.js"],
      "env": {
        "OPENAPI_URLS": "https://petstore3.swagger.io/api/v3/openapi.json,https://demo.swagger.io/v2/swagger.json"
      },
      "workingDirectory": "."
    }
  }
}
```

Then restart Copilot Workspace. Tools named like `petstore3-...` will appear.

### Cursor IDE

Add a `.cursor/mcp.json` file:

```json
{
  "mcpServers": {
    "openapi": {
      "command": "node",
      "args": ["index.js"],
      "env": {
        "OPENAPI_URLS": "https://petstore3.swagger.io/api/v3/openapi.json"
      },
      "cwd": "."
    }
  }
}
```

Restart Cursor and open the MCP tool list.

## Development

- Install deps and run a quick import smoke test (fetches Petstore spec without starting stdio):

```bash
npm install
npm run test:import
```

- Start normally (stdio):

```bash
OPENAPI_URLS="https://petstore3.swagger.io/api/v3/openapi.json" npm start
```

## Notes

- Specs are cached in memory at startup; restart to refresh.
- Server tries to infer base URL from `servers[0].url` (OpenAPI 3) or `schemes/host/basePath` (Swagger 2). If not present or you need to target a different host, set the `baseUrl` parameter on a tool call.
- Security schemes (auth) are not auto-wired; pass headers (e.g. `Authorization`) per call or inject via client configuration.

## Example config snippet

```bash
OPENAPI_URLS="http://service1/swagger/v1/swagger.json,http://service2/swagger/v1/swagger.json"
node index.js
```
