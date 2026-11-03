# ocr-dispatch

Starts an [OpenCodeReview](https://github.com/alibaba/open-code-review) review
for every pull request in the owner's repositories, including repositories
that have no review workflow file. It receives the `pull_request` webhook of
the `ocr-reviewer` GitHub App and dispatches the `ocr-dispatch.yml` workflow in
`Timpan4/wall-e-infra`, which runs the review on wall-e through
[`Timpan4/ocr-review`](https://github.com/Timpan4/ocr-review)'s
`review-app.yml`.

## How it works

1. GitHub sends `pull_request` events from every repository the reviewer App
   is installed on to `https://ocr.timpan.dev/hooks/github`.
2. The receiver checks `X-Hub-Signature-256` against the webhook secret and
   refuses bodies over 25 MB, which GitHub never delivers.
3. It dispatches a review only for the `opened`, `synchronize`, `reopened`, and
   `ready_for_review` actions on non-draft pull requests whose head branch is in
   the base repository, in a repository the configured owner owns. Fork heads
   never reach the review runners. Kargo promotion branches
   (`kargo/promotion/...`) are skipped.
4. It mints an installation token for the `ocr-dispatch` App, which has
   Actions write on the dispatch repository only, and calls
   `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with
   the inputs `repository`, `pr_number`, and `head_sha`.

Responses: `202` for a dispatched or skipped event, `200` for `ping`, `401` for
a bad signature, `400` for a payload it cannot read, `413` for an oversized
body, and `502` when the dispatch fails. A failed delivery can be redelivered
from the App's Advanced settings in GitHub.

The receiver holds no review credentials. The review workflow re-reads the pull
request before it runs, so a forged or stale dispatch cannot review a fork or
an old commit.

## Configuration

| Variable | Meaning |
| --- | --- |
| `WEBHOOK_SECRET_FILE` | Path to the reviewer App's webhook secret. |
| `REVIEW_OWNER` | Account whose repositories get reviews, e.g. `Timpan4`. |
| `DISPATCH_REPOSITORY` | Repository holding the review workflow, e.g. `Timpan4/wall-e-infra`. |
| `DISPATCH_WORKFLOW` | Workflow file name. Default `ocr-dispatch.yml`. |
| `DISPATCH_REF` | Branch the workflow runs from. Default `main`. |
| `GITHUB_APP_CLIENT_ID` | The `ocr-dispatch` App's client ID (JWT issuer). |
| `GITHUB_APP_INSTALLATION_ID` | Its installation ID. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to its PEM private key. |
| `LISTEN_HOST`, `LISTEN_PORT` | Default `127.0.0.1` and `8080`. |

`GET /hooks/github/healthz` returns `200` for probes.

## Development

```sh
bun install
bun test
bun run typecheck
```

## Releases

Push a `vX.Y.Z` tag. The release workflow tests, builds and pushes
`ghcr.io/timpan4/ocr-dispatch:X.Y.Z`, and wall-e's Kargo pipeline promotes it.
