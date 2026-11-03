import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, githubDispatcher } from "../src/github";

// GitHub App keys download as PKCS#1 PEM.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const config = {
  clientId: "Iv1.dispatch",
  installationId: "99",
  privateKey,
  repository: "Timpan4/wall-e-infra",
  workflow: "ocr-dispatch.yml",
  ref: "main",
};

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

describe("GitHub dispatcher", () => {
  test("signs an RS256 app JWT within GitHub's time rules", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const [header, payload, signature] = appJwt("Iv1.dispatch", privateKey, now).split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    const seconds = now / 1000;
    expect(decode(payload!)).toEqual({ iat: seconds - 60, exp: seconds + 600, iss: "Iv1.dispatch" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  test("dispatches the review workflow with an installation token", async () => {
    const { impl, calls } = fakeFetch([
      Response.json({ token: "ghs_installation" }, { status: 201 }),
      new Response(null, { status: 204 }),
    ]);
    await githubDispatcher(config, impl).dispatch({ repository: "Timpan4/agent-setup", pullNumber: 7, headSha: "a".repeat(40) });

    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[1]!.url).toBe("https://api.github.com/repos/Timpan4/wall-e-infra/actions/workflows/ocr-dispatch.yml/dispatches");
    expect(calls[1]!.headers.Authorization).toBe("Bearer ghs_installation");
    expect(calls[1]!.body).toEqual({
      ref: "main",
      inputs: { repository: "Timpan4/agent-setup", pr_number: "7", head_sha: "a".repeat(40) },
    });
  });

  test("accepts a 200 dispatch response", async () => {
    const { impl } = fakeFetch([Response.json({ token: "t" }, { status: 201 }), Response.json({}, { status: 200 })]);
    await githubDispatcher(config, impl).dispatch({ repository: "Timpan4/x", pullNumber: 1, headSha: "b".repeat(40) });
  });

  test("reports the status of a failed token or dispatch request", async () => {
    const tokenFails = fakeFetch([new Response("bad credentials", { status: 401 })]);
    await expect(githubDispatcher(config, tokenFails.impl).dispatch({ repository: "Timpan4/x", pullNumber: 1, headSha: "b".repeat(40) }))
      .rejects.toThrow("installation token failed: 401");

    const dispatchFails = fakeFetch([Response.json({ token: "t" }, { status: 201 }), new Response("no workflow", { status: 404 })]);
    await expect(githubDispatcher(config, dispatchFails.impl).dispatch({ repository: "Timpan4/x", pullNumber: 1, headSha: "b".repeat(40) }))
      .rejects.toThrow("workflow dispatch failed: 404");
  });
});
