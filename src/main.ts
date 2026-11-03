import { readFileSync } from "node:fs";
import { githubDispatcher } from "./github";
import { createHandler, MAX_BODY_BYTES } from "./server";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

const handler = createHandler({
  webhookSecret: readFileSync(required("WEBHOOK_SECRET_FILE"), "utf8").trim(),
  owner: required("REVIEW_OWNER"),
  dispatcher: githubDispatcher({
    clientId: required("GITHUB_APP_CLIENT_ID"),
    installationId: required("GITHUB_APP_INSTALLATION_ID"),
    privateKey: readFileSync(required("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8"),
    repository: required("DISPATCH_REPOSITORY"),
    workflow: process.env.DISPATCH_WORKFLOW ?? "ocr-dispatch.yml",
    ref: process.env.DISPATCH_REF ?? "main",
  }),
});

const server = Bun.serve({
  hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
  port: Number(process.env.LISTEN_PORT ?? "8080"),
  // The handler enforces the same limit for bodies without a Content-Length.
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      console.error(error);
      return new Response("Internal error. See the ocr-dispatch container log.\n", { status: 500 });
    }
  },
});
console.log(`ocr-dispatch listening on ${server.url}`);

// As PID 1 in a container, the process gets no default SIGTERM handling.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
