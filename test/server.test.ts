import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Dispatcher } from "../src/github";
import { createHandler, MAX_BODY_BYTES } from "../src/server";
import type { ReviewRequest } from "../src/webhook";

const SECRET = "test-webhook-secret";
const SHA = "a".repeat(40);
const URL = "http://127.0.0.1:8080/hooks/github";

function pullRequestEvent(overrides: {
  action?: string;
  owner?: string;
  draft?: boolean;
  headRepo?: string | null;
  ref?: string;
} = {}) {
  const owner = overrides.owner ?? "Timpan4";
  const fullName = `${owner}/agent-setup`;
  const headRepo = overrides.headRepo === undefined ? fullName : overrides.headRepo;
  return {
    action: overrides.action ?? "synchronize",
    repository: { full_name: fullName, owner: { login: owner } },
    pull_request: {
      number: 7,
      draft: overrides.draft ?? false,
      head: {
        ref: overrides.ref ?? "feat/thing",
        sha: SHA,
        repo: headRepo === null ? null : { full_name: headRepo },
      },
    },
  };
}

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function delivery(payload: unknown, { event = "pull_request", signature }: { event?: string; signature?: string } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request(URL, {
    method: "POST",
    headers: {
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": "d-1",
      "X-Hub-Signature-256": signature ?? sign(body),
      "Content-Type": "application/json",
    },
    body,
  });
}

function setup(dispatch: (request: ReviewRequest) => Promise<void> = async () => {}) {
  const dispatched: ReviewRequest[] = [];
  const dispatcher: Dispatcher = {
    dispatch: async (request) => {
      dispatched.push(request);
      await dispatch(request);
    },
  };
  const logs: string[] = [];
  const handler = createHandler({ webhookSecret: SECRET, owner: "Timpan4", dispatcher, log: (m) => logs.push(m) });
  return { handler, dispatched, logs };
}

describe("webhook handler", () => {
  test("dispatches a review for a same-repository pull request push", async () => {
    const { handler, dispatched } = setup();
    const response = await handler(delivery(pullRequestEvent()));
    expect(response.status).toBe(202);
    expect(dispatched).toEqual([{ repository: "Timpan4/agent-setup", pullNumber: 7, headSha: SHA }]);
  });

  test.each(["opened", "reopened", "ready_for_review"])("dispatches on %s", async (action) => {
    const { handler, dispatched } = setup();
    expect((await handler(delivery(pullRequestEvent({ action })))).status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });

  test.each([
    ["closed action", pullRequestEvent({ action: "closed" })],
    ["labeled action", pullRequestEvent({ action: "labeled" })],
    ["draft", pullRequestEvent({ draft: true })],
    ["fork head", pullRequestEvent({ headRepo: "stranger/agent-setup" })],
    ["deleted fork head", pullRequestEvent({ headRepo: null })],
    ["another owner", pullRequestEvent({ owner: "someone-else" })],
    ["Kargo promotion branch", pullRequestEvent({ ref: "kargo/promotion/abc" })],
  ])("skips a %s without dispatching", async (_name, payload) => {
    const { handler, dispatched } = setup();
    expect((await handler(delivery(payload))).status).toBe(202);
    expect(dispatched).toHaveLength(0);
  });

  test("matches the owner without regard to case", async () => {
    const { handler, dispatched } = setup();
    await handler(delivery(pullRequestEvent({ owner: "timpan4" })));
    expect(dispatched).toHaveLength(1);
  });

  test("rejects a wrong, missing, or malformed signature before reading the payload", async () => {
    const { handler, dispatched } = setup();
    const body = JSON.stringify(pullRequestEvent());
    for (const signature of [sign(body, "other-secret"), "", "sha256=zz", `sha1=${"0".repeat(40)}`]) {
      expect((await handler(delivery(body, { signature }))).status).toBe(401);
    }
    expect(dispatched).toHaveLength(0);
  });

  test("answers ping and ignores other signed events", async () => {
    const { handler, dispatched } = setup();
    expect((await handler(delivery({ zen: "hi" }, { event: "ping" }))).status).toBe(200);
    expect((await handler(delivery({}, { event: "push" }))).status).toBe(202);
    expect(dispatched).toHaveLength(0);
  });

  test.each([
    ["invalid JSON", "{"],
    ["missing pull_request", { action: "opened", repository: { full_name: "Timpan4/x", owner: { login: "Timpan4" } } }],
    [
      "non-integer number",
      { ...pullRequestEvent(), pull_request: { ...pullRequestEvent().pull_request, number: 1.5 } },
    ],
    [
      "short head SHA",
      {
        ...pullRequestEvent(),
        pull_request: { ...pullRequestEvent().pull_request, head: { ref: "x", sha: "abc", repo: { full_name: "Timpan4/agent-setup" } } },
      },
    ],
    [
      "repository name with a slash",
      { ...pullRequestEvent(), repository: { full_name: "Timpan4/a/b", owner: { login: "Timpan4" } } },
    ],
  ])("returns 400 for %s", async (_name, payload) => {
    const { handler, dispatched } = setup();
    expect((await handler(delivery(payload))).status).toBe(400);
    expect(dispatched).toHaveLength(0);
  });

  test("returns 502 when the dispatch fails, so GitHub records a failed delivery", async () => {
    const { handler, logs } = setup(async () => {
      throw new Error("GitHub workflow dispatch failed: 404");
    });
    expect((await handler(delivery(pullRequestEvent()))).status).toBe(502);
    expect(logs.at(-1)).toContain("dispatch failed for Timpan4/agent-setup#7");
  });

  test("refuses a body larger than GitHub delivers, by header and by stream", async () => {
    const { handler } = setup();
    const declared = new Request(URL, {
      method: "POST",
      headers: { "Content-Length": String(MAX_BODY_BYTES + 1) },
      body: "x",
    });
    expect((await handler(declared)).status).toBe(413);

    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const streamed = new Request(URL, { method: "POST", body: stream });
    expect((await handler(streamed)).status).toBe(413);
  });

  test("serves health on its own path and 404 elsewhere", async () => {
    const { handler } = setup();
    expect((await handler(new Request(`${URL}/healthz`))).status).toBe(200);
    expect((await handler(new Request("http://127.0.0.1:8080/settings/"))).status).toBe(404);
    expect((await handler(new Request(URL))).status).toBe(405);
  });
});
