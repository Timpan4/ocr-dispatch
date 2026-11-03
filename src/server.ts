import type { Dispatcher } from "./github";
import { decide, PayloadError, signatureMatches } from "./webhook";

export const HOOK_PATH = "/hooks/github";
const HEALTH_PATH = `${HOOK_PATH}/healthz`;

/** GitHub does not deliver webhook payloads larger than 25 MB, so a larger body is not from GitHub. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface HandlerOptions {
  webhookSecret: string;
  /** Account whose repositories get reviews, e.g. Timpan4. */
  owner: string;
  dispatcher: Dispatcher;
  log?: (message: string) => void;
}

class BodyTooLarge extends Error {}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const reply = (status: number, message: string) => new Response(`${message}\n`, { status });

export function createHandler({ webhookSecret, owner, dispatcher, log = console.log }: HandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === HEALTH_PATH && request.method === "GET") return reply(200, "ok");
    if (pathname !== HOOK_PATH) return reply(404, "Not found.");
    if (request.method !== "POST") return reply(405, "Use POST.");

    let body: Uint8Array;
    try {
      body = await readBody(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLarge) return reply(413, "Body too large.");
      throw error;
    }
    if (!signatureMatches(webhookSecret, body, request.headers.get("X-Hub-Signature-256"))) {
      return reply(401, "Bad signature.");
    }

    const delivery = request.headers.get("X-GitHub-Delivery") ?? "unknown";
    const event = request.headers.get("X-GitHub-Event");
    if (event === "ping") return reply(200, "pong");
    if (event !== "pull_request") return reply(202, `Ignored event ${event ?? "(none)"}.`);

    let decision;
    try {
      decision = decide(JSON.parse(new TextDecoder().decode(body)), owner);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof PayloadError) {
        log(`delivery ${delivery}: rejected payload: ${error.message}`);
        return reply(400, "Not a pull_request payload.");
      }
      throw error;
    }
    if (decision.kind === "skip") {
      log(`delivery ${delivery}: skipped, ${decision.reason}`);
      return reply(202, `Skipped: ${decision.reason}.`);
    }

    const { repository, pullNumber, headSha } = decision.request;
    try {
      await dispatcher.dispatch(decision.request);
    } catch (error) {
      // A failed delivery shows in the App's Recent Deliveries, where it can be redelivered.
      log(`delivery ${delivery}: dispatch failed for ${repository}#${pullNumber}: ${String(error)}`);
      return reply(502, "Dispatch failed.");
    }
    log(`delivery ${delivery}: dispatched ${repository}#${pullNumber} at ${headSha}`);
    return reply(202, "Review dispatched.");
  };
}
