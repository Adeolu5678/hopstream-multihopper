import http from "node:http";
import type { WebhookEventPayload } from "../types/multihopper.js";
import { MULTIHOPPER_SIGNATURE_HEADER, parseVerifiedWebhook } from "./verify.js";

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export interface WebhookServerOptions {
  secret: string;
  port?: number;
  host?: string;
  maxStoredEvents?: number;
  maxBodyBytes?: number;
  onEvent?: (payload: WebhookEventPayload) => void | Promise<void>;
}

export interface StoredWebhookEvent {
  receivedAt: string;
  payload: WebhookEventPayload;
}

export interface WebhookServerHandle {
  server: http.Server;
  url: string;
  events: StoredWebhookEvent[];
  close: () => Promise<void>;
}

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Webhook payload exceeds ${limitBytes} byte limit`);
    this.name = "PayloadTooLargeError";
  }
}

function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        req.resume();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}

export async function startWebhookServer(options: WebhookServerOptions): Promise<WebhookServerHandle> {
  const events: StoredWebhookEvent[] = [];
  const maxStored = options.maxStoredEvents ?? 200;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];

    if (method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, eventsBuffered: events.length }));
      return;
    }

    if (method === "GET" && path === "/events") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: events }));
      return;
    }

    if (method === "POST" && (path === "/webhooks/multihopper" || path === "/")) {
      try {
        const rawBody = await readRawBody(req, maxBodyBytes);
        const signatureHeader = req.headers[MULTIHOPPER_SIGNATURE_HEADER];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        const payload = parseVerifiedWebhook(rawBody, signature, options.secret);

        events.unshift({
          receivedAt: new Date().toISOString(),
          payload
        });
        if (events.length > maxStored) {
          events.length = maxStored;
        }

        await options.onEvent?.(payload);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, event: payload.event }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid webhook request";
        const status =
          err instanceof PayloadTooLargeError ? 413 : message.includes("signature") ? 401 : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : options.port ?? 8787;
  const host = options.host ?? "127.0.0.1";

  return {
    server,
    url: `http://${host}:${actualPort}`,
    events,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
