import WebSocket from "ws";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = WebSocket;

import express from "express";
import { Client } from "./client/index.js";
import { SSEClientTransport } from "./client/sse.js";
import { StdioClientTransport } from "./client/stdio.js";
import { WebSocketClientTransport } from "./client/websocket.js";
import { Server } from "./server/index.js";
import { SSEServerTransport } from "./server/sse.js";
import { StdioServerTransport } from "./server/stdio.js";
import { ListResourcesResultSchema, ListToolsRequestSchema, ListToolsResultSchema } from './types.js'
import { McpServer, ResourceTemplate } from './server/mcp.js'
import { z } from 'zod'

async function runClient(url_or_command: string, args: string[]) {
  const client = new Client(
    {
      name: "mcp-typescript test client",
      version: "0.1.0",
    },
    {
      capabilities: {
        sampling: {},
      },
    },
  );

  let clientTransport;

  let url: URL | undefined = undefined;
  try {
    url = new URL(url_or_command);
  } catch {
    // Ignore
  }

  if (url?.protocol === "http:" || url?.protocol === "https:") {
    clientTransport = new SSEClientTransport(new URL(url_or_command));
  } else if (url?.protocol === "ws:" || url?.protocol === "wss:") {
    clientTransport = new WebSocketClientTransport(new URL(url_or_command));
  } else {
    clientTransport = new StdioClientTransport({
      command: url_or_command,
      args,
    });
  }

  console.log("Connected to server.");

  await client.connect(clientTransport);
  console.log("Initialized.");

  const resources = await client.request({ method: "resources/list" }, ListResourcesResultSchema);
  console.dir(resources, { depth: null })

  const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
  console.dir(tools, { depth: null })

  await client.close();
  console.log("Closed.");
}

async function runServer(port: number | null) {
  if (port !== null) {
    const app = express();

    // Request logging middleware
    app.use((req, res, next) => {
      const start = Date.now();
      const requestId = crypto.randomUUID();

      console.log(`[${requestId}] ${new Date().toISOString()} - ${req.method} ${req.originalUrl} - Request received`);

      // Log request headers if needed
      console.log(`[${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));

      // Add response finish listener to log completion
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${requestId}] ${new Date().toISOString()} - ${req.method} ${req.originalUrl} - Response sent - Status: ${res.statusCode} - Duration: ${duration}ms`);
      });

      next();
    });

    // Super permissive CORS middleware
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', '*');
      res.header('Access-Control-Allow-Methods', '*');
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Max-Age', '86400'); // 24 hours

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.status(204).send();
      }

      next();
    });


    app.get('/.well-known/oauth-authorization-server', async (req, res) => {
      res.json({
        issuer: `https://dash.cloudflare.com`,
        authorization_endpoint: `https://dash.cloudflare.com/oauth2/auth`,
        token_endpoint: `https://dash.cloudflare.com/oauth2/token`,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        scopes_supported: ['account:read', 'user:read', 'offline_access'],
        response_modes_supported: ['query'],
        revocation_endpoint: `https://dash.cloudflare.com/oauth2/token`,
        code_challenge_methods_supported: ['plain', 'S256'],
      })
      return
    })

    let servers: McpServer[] = [];

    app.get("/sse", async (req, res) => {
      console.log("Got new SSE connection");

      res.status(401).send('Unauthorized');
      return;

      const transport = new SSEServerTransport("/message", res);
      const server = new McpServer(
        {
          name: "mcp-typescript test server",
          version: "0.1.0",
        },
      );

      server.resource(
        "config",
        "config://app",
        async (uri) => ({
          contents: [{
            uri: uri.href,
            text: "App configuration here"
          }]
        })
      );

      server.tool("add",
        { a: z.number(), b: z.number() },
        async ({ a, b }) => ({
          content: [{ type: "text", text: String(a + b) }]
        })
      );

      servers.push(server);

      server.server.onclose = () => {
        console.log("SSE connection closed");
        servers = servers.filter((s) => s !== server);
      };

      await server.connect(transport);
    });

    app.post("/message", async (req, res) => {
      console.log("Received message");

      const sessionId = req.query.sessionId as string;
      const transport = servers
        .map((s) => s.server.transport as SSEServerTransport)
        .find((t) => t.sessionId === sessionId);
      if (!transport) {
        res.status(404).send("Session not found");
        return;
      }

      await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}/sse`);
    });
  } else {
    const server = new Server(
      {
        name: "mcp-typescript test server",
        version: "0.1.0",
      },
      {
        capabilities: {
          prompts: {},
          resources: {},
          tools: {},
          logging: {},
        },
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.log("Server running on stdio");
  }
}

const args = process.argv.slice(2);
const command = args[0];
switch (command) {
  case "client":
    if (args.length < 2) {
      console.error("Usage: client <server_url_or_command> [args...]");
      process.exit(1);
    }

    runClient(args[1], args.slice(2)).catch((error) => {
      console.error(error);
      process.exit(1);
    });

    break;

  case "server": {
    const port = args[1] ? parseInt(args[1]) : null;
    runServer(port).catch((error) => {
      console.error(error);
      process.exit(1);
    });

    break;
  }

  default:
    console.error("Unrecognized command:", command);
}
