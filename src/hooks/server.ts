import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { HookNotification, CompletionNotification } from "../types.js";

export type NotificationHandler = (notification: HookNotification) => void;
export type CompletionHandler = (completion: CompletionNotification) => void;

export interface HookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHookServer(
  port: number,
  onNotification: NotificationHandler,
  onCompletion: CompletionHandler
): HookServer {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/notify") {
      handleNotify(req, res, onNotification);
    } else if (req.method === "POST" && req.url === "/complete") {
      handleComplete(req, res, onCompletion);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  // Permanent error handler for runtime errors
  server.on("error", (err) => {
    console.error("Hook server error:", err);
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        const startupErrorHandler = (err: Error) => reject(err);
        server.once("error", startupErrorHandler);
        server.listen(port, () => {
          server.removeListener("error", startupErrorHandler);
          console.log(`   Hook server listening on port ${port}`);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

const MAX_BODY_SIZE = 64 * 1024; // 64KB

function handleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  onNotification: NotificationHandler
): void {
  let body = "";
  let aborted = false;

  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      aborted = true;
      req.destroy();
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
    }
  });

  req.on("end", () => {
    if (aborted) return;
    try {
      const notification = JSON.parse(body) as HookNotification;

      // Validate required fields and types
      if (
        typeof notification.session !== "string" ||
        typeof notification.tool !== "string" ||
        typeof notification.input !== "object" ||
        !notification.input ||
        !Array.isArray(notification.input.questions)
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid notification format" }));
        return;
      }

      onNotification(notification);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });

  req.on("error", () => {
    if (aborted) return;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request error" }));
  });
}

function handleComplete(
  req: IncomingMessage,
  res: ServerResponse,
  onCompletion: CompletionHandler
): void {
  let body = "";
  let aborted = false;

  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      aborted = true;
      req.destroy();
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
    }
  });

  req.on("end", () => {
    if (aborted) return;
    try {
      const completion = JSON.parse(body) as CompletionNotification;

      // Validate required fields and optional field types
      if (
        typeof completion.session !== "string" ||
        (completion.status !== "success" && completion.status !== "error") ||
        (completion.pr !== undefined && typeof completion.pr !== "string") ||
        (completion.error !== undefined && typeof completion.error !== "string")
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid completion format" }));
        return;
      }

      onCompletion(completion);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });

  req.on("error", () => {
    if (aborted) return;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request error" }));
  });
}
