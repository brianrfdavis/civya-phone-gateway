import type { IncomingMessage, ServerResponse } from "node:http";
import type { FoundationJobClient } from "@/lib/jobs";
import { readPstnRuntimeState } from "./config";
import { OpenAISipController } from "./openai-sip";

const MAX_WEBHOOK_BYTES = 256_000;

export class CallControlHttpHandler {
  readonly controller: OpenAISipController;

  constructor(jobs: FoundationJobClient) {
    this.controller = new OpenAISipController(jobs);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== "POST" || request.url?.split("?", 1)[0] !== "/webhooks/openai") return false;
    const pstn = readPstnRuntimeState();
    if (!pstn.enabled) {
      respond(response, 503, { accepted: false, code: "pstn_disabled" });
      return true;
    }
    if (!pstn.configured) {
      respond(response, 503, { accepted: false, code: "call_control_not_configured" });
      return true;
    }
    const rawBody = await readBody(request, MAX_WEBHOOK_BYTES).catch(() => null);
    if (rawBody === null) {
      respond(response, 413, { accepted: false, code: "payload_too_large" });
      return true;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const result = await this.controller.handleWebhook(rawBody, headers);
    respond(response, result.status, result.body, result.headers);
    return true;
  }

  close(): void {
    this.controller.close();
  }
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximum) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respond(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}
