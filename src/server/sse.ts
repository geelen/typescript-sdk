import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Transport } from "../shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "../types.js";
import getRawBody from "raw-body";
import contentType from "content-type";
import { Context } from "hono";

const MAXIMUM_MESSAGE_SIZE = "4mb";

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This transport is only available in Node.js environments.
 */
export class SSEServerTransport implements Transport {
  _sseResponse?: ServerResponse;
  private _sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * Creates a new SSE server transport, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
   */
  constructor(
    private _endpoint: string,
    private res: ServerResponse,
  ) {
    this._sessionId = randomUUID();
  }

  /**
   * Handles the initial SSE connection request.
   *
   * This should be called when a GET request is made to establish the SSE stream.
   */
  async start(): Promise<void> {
    if (this._sseResponse) {
      throw new Error(
        "SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send the endpoint event
    this.res.write(
      `event: endpoint\ndata: ${encodeURI(this._endpoint)}?sessionId=${this._sessionId}\n\n`,
    );

    this._sseResponse = this.res;
    this.res.on("close", () => {
      this._sseResponse = undefined;
      this.onclose?.();
    });
  }

  /**
   * Handles incoming POST messages.
   *
   * This should be called when a POST request is made to send a message to the server.
   */
  async handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    if (!this._sseResponse) {
      const message = "SSE connection not established";
      res.writeHead(500).end(message);
      throw new Error(message);
    }

    let body: string | unknown;
    try {
      const ct = contentType.parse(req.headers["content-type"] ?? "");
      if (ct.type !== "application/json") {
        throw new Error(`Unsupported content-type: ${ct}`);
      }

      body = parsedBody ?? await getRawBody(req, {
        limit: MAXIMUM_MESSAGE_SIZE,
        encoding: ct.parameters.charset ?? "utf-8",
      });
    } catch (error) {
      res.writeHead(400).end(String(error));
      this.onerror?.(error as Error);
      return;
    }

    try {
      await this.handleMessage(typeof body === 'string' ? JSON.parse(body) : body);
    } catch {
      res.writeHead(400).end(`Invalid message: ${body}`);
      return;
    }

    res.writeHead(202).end("Accepted");
  }

  /**
   * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
   */
  async handleMessage(message: unknown): Promise<void> {
    let parsedMessage: JSONRPCMessage;
    try {
      parsedMessage = JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }

    this.onmessage?.(parsedMessage);
  }

  async close(): Promise<void> {
    this._sseResponse?.end();
    this._sseResponse = undefined;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._sseResponse) {
      throw new Error("Not connected");
    }

    this._sseResponse.write(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`,
    );
  }

  /**
   * Returns the session ID for this transport.
   *
   * This can be used to route incoming POST requests.
   */
  get sessionId(): string {
    return this._sessionId;
  }
}

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 *
 * This version is adapted for use with Hono.
 */
export class HonoSSEServerTransport implements Transport {
  private _writer?: WritableStreamDefaultWriter<Uint8Array>;
  private _encoder = new TextEncoder();
  private _sessionId: string;
  private _isConnectionClosed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * Creates a new SSE server transport for Hono, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
   */
  constructor(
    private _endpoint: string,
    private context: Context,
  ) {
    this._sessionId = randomUUID();
  }

  /**
   * Handles the initial SSE connection request.
   *
   * This should be called when a GET request is made to establish the SSE stream.
   */
  async start(): Promise<void> {
    if (this._writer) {
      throw new Error(
        "HonoSSEServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    // Create a streaming response
    const { readable, writable } = new TransformStream();
    this._writer = writable.getWriter();

    // Set SSE headers and begin streaming response
    // Create and send the response
    const response = new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
    this.context.res = response;

    // Send the endpoint event
    await this.writeEvent("endpoint", `${encodeURI(this._endpoint)}?sessionId=${this._sessionId}`);

    // Set up connection close detection
    this.context.req.raw.signal.addEventListener('abort', () => {
      this.handleConnectionClose();
    });
  }

  /**
   * Write an SSE event to the stream
   */
  private async writeEvent(event: string, data: string): Promise<void> {
    if (!this._writer || this._isConnectionClosed) {
      throw new Error("Not connected");
    }

    const content = `event: ${event}\ndata: ${data}\n\n`;
    await this._writer.write(this._encoder.encode(content));
  }

  /**
   * Handle connection close
   */
  private handleConnectionClose(): void {
    if (!this._isConnectionClosed) {
      this._isConnectionClosed = true;
      this._writer?.close().catch(err => {
        console.error("Error closing writer:", err);
      });
      this._writer = undefined;
      this.onclose?.();
    }
  }

  /**
   * Handles incoming POST messages.
   *
   * This should be called when a POST request is made to send a message to the server.
   */
  async handlePostMessage(
    context: Context,
    parsedBody?: unknown,
  ): Promise<Response> {
    if (!this._writer || this._isConnectionClosed) {
      const message = "SSE connection not established";
      return new Response(message, { status: 500 });
    }

    let body: unknown;
    try {
      const contentTypeHeader = context.req.header("content-type") || "";
      if (!contentTypeHeader.includes("application/json")) {
        throw new Error(`Unsupported content-type: ${contentTypeHeader}`);
      }

      // Use the provided parsed body or parse the request body
      body = parsedBody ?? await context.req.json();
    } catch (error) {
      this.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }

    try {
      await this.handleMessage(body);
    } catch (error) {
      return new Response(`Invalid message: ${JSON.stringify(body)}`, { status: 400 });
    }

    return new Response("Accepted", { status: 202 });
  }

  /**
   * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
   */
  async handleMessage(message: unknown): Promise<void> {
    let parsedMessage: JSONRPCMessage;
    try {
      parsedMessage = JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }

    this.onmessage?.(parsedMessage);
  }

  async close(): Promise<void> {
    this.handleConnectionClose();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._writer || this._isConnectionClosed) {
      throw new Error("Not connected");
    }

    await this.writeEvent("message", JSON.stringify(message));
  }

  /**
   * Returns the session ID for this transport.
   *
   * This can be used to route incoming POST requests.
   */
  get sessionId(): string {
    return this._sessionId;
  }
}