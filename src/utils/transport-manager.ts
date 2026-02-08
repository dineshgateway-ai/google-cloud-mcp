/**
 * Transport manager for MCP server with SSE and HTTP support
 *
 * Implements MCP specification 2025-06-18 transport requirements:
 * - HTTP endpoint with POST and GET support
 * - SSE (Server-Sent Events) transport using SDK SSEServerTransport
 * - UTF-8 encoding for all JSON-RPC messages
 * - Support for application/json and text/event-stream content types
 * - Multiple simultaneous client connections
 * - Stdio transport backwards compatibility
 */
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ISessionManager,
  ILogger,
  TransportConfig,
  SecurityValidator,
} from "./interfaces.js";

/**
 * Transport manager implementing MCP specification requirements with dependency injection
 */
export class TransportManager {
  private server: McpServer;
  private httpServer?: http.Server;
  private activeConnections = new Set<http.ServerResponse>();
  private sseTransports = new Map<string, SSEServerTransport>();
  private config: TransportConfig;
  private logger: ILogger;
  private sessionManager: ISessionManager;
  private securityValidator: SecurityValidator;

  constructor(
    server: McpServer,
    sessionManager: ISessionManager,
    securityValidator: SecurityValidator,
    logger: ILogger,
    config: Partial<TransportConfig> = {},
  ) {
    this.server = server;
    this.sessionManager = sessionManager;
    this.securityValidator = securityValidator;
    this.logger = logger;
    this.config = {
      supportStdio: true,
      supportHttp: false,
      supportSse: false,
      httpPort: parseInt(process.env.MCP_HTTP_PORT || "3000"),
      httpHost: process.env.MCP_HTTP_HOST || "127.0.0.1",
      maxConnections: parseInt(process.env.MCP_MAX_CONNECTIONS || "10"),
      ...config,
    };
  }

  /**
   * Start the appropriate transport based on configuration
   */
  async startTransport(): Promise<void> {
    // Always support stdio transport if requested
    if (this.config.supportStdio) {
      await this.startStdioTransport();
    }

    // Start HTTP/SSE transport if configured
    if (this.config.supportHttp || this.config.supportSse) {
      await this.startHttpTransport();
    }
  }

  /**
   * Start stdio transport (backwards compatibility)
   */
  private async startStdioTransport(): Promise<void> {
    this.logger.info("Starting stdio transport");
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info("Stdio transport started successfully");
  }

  /**
   * Start HTTP transport with SSE support
   */
  private async startHttpTransport(): Promise<void> {
    this.logger.info(
      `Starting HTTP transport on ${this.config.httpHost}:${this.config.httpPort}`,
    );

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.httpServer.on("connection", (socket) => {
      socket.setNoDelay(true);
      socket.setTimeout(30000);
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(
        this.config.httpPort,
        this.config.httpHost,
        () => {
          this.logger.info(
            `HTTP transport listening on ${this.config.httpHost}:${this.config.httpPort}`,
          );
          resolve();
        },
      );

      this.httpServer!.on("error", (error) => {
        this.logger.error(`HTTP transport error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Handle HTTP requests with MCP protocol support
   */
  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const clientId = req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    try {
      // Security: Validate request headers
      const headerValidation = this.securityValidator.validateRequestHeaders(
        req.headers,
      );
      if (!headerValidation.valid) {
        this.securityValidator.logSecurityEvent(
          "suspicious_headers",
          { clientIp: clientId, userAgent, errors: headerValidation.errors },
          "medium",
        );
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      // Security: Rate limiting
      const rateLimitCheck = this.securityValidator.checkRateLimit(clientId);
      if (!rateLimitCheck.allowed) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("Too Many Requests");
        return;
      }

      // Handle OPTIONS
      if (req.method === "OPTIONS") {
        this.handleOptionsRequest(res);
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // Route requests
      if (req.method === "GET") {
        if (url.pathname === "/sse" && this.config.supportSse) {
          await this.handleSseConnection(req, res);
        } else if (url.pathname === "/health") {
          this.handleHealthCheck(res);
        } else {
          res.writeHead(404).end("Not Found");
        }
      } else if (req.method === "POST") {
        if (url.pathname === "/message") {
          await this.handlePostMessage(req, res, url);
        } else {
          res.writeHead(404).end("Not Found");
        }
      } else {
        res.writeHead(405).end("Method Not Allowed");
      }
    } catch (error) {
      this.logger.error(`Request error: ${error}`);
      if (!res.writableEnded) {
        res.writeHead(500).end("Internal Server Error");
      }
    }
  }

  /**
   * Handle initial SSE connection
   */
  private async handleSseConnection(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.sseTransports.size >= this.config.maxConnections) {
      res.writeHead(503).end("Connection limit reached");
      return;
    }

    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId;
    this.sseTransports.set(sessionId, transport);

    this.logger.info(`New SSE connection established: ${sessionId}`);

    transport.onclose = () => {
      this.logger.info(`SSE connection closed: ${sessionId}`);
      this.sseTransports.delete(sessionId);
    };

    transport.onerror = (error) => {
      this.logger.error(`SSE transport error [${sessionId}]: ${error}`);
    };

    await this.server.connect(transport);
  }

  /**
   * Handle POST messages for existing SSE sessions
   */
  private async handlePostMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400).end("Missing sessionId");
      return;
    }

    const transport = this.sseTransports.get(sessionId);
    if (!transport) {
      res.writeHead(404).end("Session not found");
      return;
    }

    await transport.handlePostMessage(req, res);
  }

  private handleOptionsRequest(res: http.ServerResponse): void {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
  }

  private handleHealthCheck(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        activeConnections: this.sseTransports.size,
      }),
    );
  }

  /**
   * Gracefully shutdown
   */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down transports");
    for (const transport of this.sseTransports.values()) {
      await transport.close();
    }
    this.sseTransports.clear();

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          this.logger.info("HTTP transport closed");
          resolve();
        });
      });
    }
  }
}
