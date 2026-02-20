import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { config } from "../config.js";
import { routeApi } from "./routes.js";

/**
 * Content-Type map for static file serving.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Resolve the public directory path.
 * Uses config.mirandaHome to find the public/ directory
 * relative to the project root.
 */
function getPublicDir(): string {
  return join(config.mirandaHome, "public");
}

/**
 * Serve a static file from the public/ directory.
 * Returns true if a file was served, false otherwise.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const publicDir = getPublicDir();

  // Default to index.html for root
  let filePath = pathname === "/" ? "/index.html" : pathname;

  // Resolve and verify path stays within public directory
  const resolved = resolve(publicDir, filePath.slice(1));
  if (!resolved.startsWith(resolve(publicDir))) {
    // Path traversal attempt
    return false;
  }

  if (!existsSync(resolved)) {
    return false;
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    return false;
  }

  const ext = extname(resolved).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(resolved).pipe(res);
  return true;
}

/**
 * Main request handler.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  try {
    // Try API routes first
    const handled = await routeApi(req, res, pathname);
    if (handled) return;

    // Try static files
    if (serveStatic(req, res, pathname)) return;

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("HTTP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

let server: Server | null = null;

/**
 * Start the HTTP API server.
 */
export function startApiServer(): Server {
  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Unhandled HTTP error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`   API server port ${config.port} already in use`);
    } else {
      console.error("API server error:", err);
    }
  });
  server.listen(config.port, () => {
    console.log(`   API server: http://localhost:${config.port}`);
  });

  return server;
}

/**
 * Stop the HTTP API server gracefully.
 */
export async function stopApiServer(): Promise<void> {
  if (!server) return;

  return new Promise((resolve) => {
    server!.close(() => {
      console.log("   API server stopped");
      server = null;
      resolve();
    });
  });
}
