import { createSign } from "node:crypto";
import type { ReviewRequest } from "./webhook";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export interface Dispatcher {
  /** Starts the review workflow for one pull request head. */
  dispatch(request: ReviewRequest): Promise<void>;
}

export interface DispatchConfig {
  clientId: string;
  installationId: string;
  privateKey: string;
  /** Repository that holds the review workflow, e.g. Timpan4/wall-e-infra. */
  repository: string;
  /** Workflow file name in that repository, e.g. ocr-dispatch.yml. */
  workflow: string;
  /** Branch whose copy of the workflow runs. */
  ref: string;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/** App JWT per GitHub's rules: RS256, iat 60 s back for clock drift, exp at most 10 minutes ahead. */
export function appJwt(clientId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 10 * 60, iss: clientId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

async function expectOk(response: Response, action: string): Promise<Response> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub ${action} failed: ${response.status} ${detail}`);
  }
  return response;
}

export function githubDispatcher(config: DispatchConfig, fetchImpl: typeof fetch = fetch): Dispatcher {
  const headers = (token: string) => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  });

  // A fresh installation token per event: pull request events are infrequent,
  // and this avoids caching a credential.
  async function installationToken(): Promise<string> {
    const response = await fetchImpl(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: headers(appJwt(config.clientId, config.privateKey)),
    });
    const body = (await (await expectOk(response, "installation token")).json()) as { token: string };
    return body.token;
  }

  return {
    async dispatch(request) {
      const token = await installationToken();
      const url = `${API}/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: config.ref,
          inputs: {
            repository: request.repository,
            pr_number: String(request.pullNumber),
            head_sha: request.headSha,
          },
        }),
      });
      await expectOk(response, "workflow dispatch");
    },
  };
}
