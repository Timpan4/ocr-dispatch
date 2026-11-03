import { createHmac, timingSafeEqual } from "node:crypto";

/** Pull request actions that put new code in front of the reviewer. */
const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** A pull request head to review, validated for use as workflow_dispatch inputs. */
export interface ReviewRequest {
  repository: string;
  pullNumber: number;
  headSha: string;
}

export type Decision =
  | { kind: "review"; request: ReviewRequest }
  | { kind: "skip"; reason: string };

/** The body is not a pull_request payload this service understands. */
export class PayloadError extends Error {}

/**
 * Checks GitHub's X-Hub-Signature-256 header: "sha256=" and the hex HMAC-SHA256
 * of the raw body under the webhook secret, compared in constant time.
 */
export function signatureMatches(secret: string, body: Uint8Array, header: string | null): boolean {
  const prefix = "sha256=";
  if (header === null || !header.startsWith(prefix)) return false;
  const hex = header.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(hex, "hex"), expected);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new PayloadError(`${path} must be a string`);
  return value;
}

/**
 * Decides whether a pull_request event needs a review. Only same-repository
 * pull requests in the owner's repositories qualify: a fork's head must never
 * reach the review runners, which hold the owner's ChatGPT session.
 */
export function decide(payload: unknown, owner: string): Decision {
  const event = record(payload, "payload");
  const action = text(event.action, "action");
  if (!REVIEW_ACTIONS.has(action)) return { kind: "skip", reason: `action ${action}` };

  const repository = record(event.repository, "repository");
  const fullName = text(repository.full_name, "repository.full_name");
  const repoOwner = text(record(repository.owner, "repository.owner").login, "repository.owner.login");
  if (repoOwner.toLowerCase() !== owner.toLowerCase()) {
    return { kind: "skip", reason: `repository owner ${repoOwner}` };
  }
  if (!FULL_NAME.test(fullName)) throw new PayloadError("repository.full_name is not owner/name");

  const pull = record(event.pull_request, "pull_request");
  const pullNumber = pull.number;
  if (typeof pullNumber !== "number" || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new PayloadError("pull_request.number must be a positive integer");
  }
  if (typeof pull.draft !== "boolean") throw new PayloadError("pull_request.draft must be a boolean");
  if (pull.draft) return { kind: "skip", reason: "draft" };

  const head = record(pull.head, "pull_request.head");
  // head.repo is null when the fork that opened the pull request was deleted.
  const headRepo = head.repo === null ? null : record(head.repo, "pull_request.head.repo");
  const headName = headRepo === null ? null : text(headRepo.full_name, "pull_request.head.repo.full_name");
  if (headName !== fullName) return { kind: "skip", reason: "head is not in the base repository" };

  const ref = text(head.ref, "pull_request.head.ref");
  if (ref.startsWith("kargo/promotion/")) return { kind: "skip", reason: "Kargo promotion" };

  const headSha = text(head.sha, "pull_request.head.sha");
  if (!COMMIT_SHA.test(headSha)) throw new PayloadError("pull_request.head.sha is not a commit SHA");

  return { kind: "review", request: { repository: fullName, pullNumber, headSha } };
}
