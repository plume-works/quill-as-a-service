# quill-as-a-service

Quill reviews the pull requests of the repositories in its configuration. A GitHub App
(`plume-works-quill`) sends it `pull_request` webhooks; the service decides whether to review,
and runs each review in a reviewer container that checks out the head and runs Claude Code
with the `quill-review` skill, which writes the review to a file. The service posts that review
on the reviewed commit. Each review reports a `Quill Review` check run.

- `src/`: the Bun service; `test/`: its tests (`bun test`).
- `reviewer/`: the reviewer image, with its skills in `reviewer/skills/`; `tests/`: its
  entrypoint's tests (`uv run pytest`).
- `service/`: the service image, run under sysbox.
- [docs/deploy.md](docs/deploy.md): deploying and operating the service.
- [docs/plans/](docs/plans/): the plans of the work on the service.
- [docs/adrs/](docs/adrs/): the decisions the service follows.

## Trying a review locally

`scripts/review-locally.ts` runs one live review on this machine's Docker engine, the way the
service runs it, and prints the review the reviewer wrote instead of posting it:

```bash
export QUILL_CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`
export GH_TOKEN=...                        # read-only: Contents and Pull requests
bun scripts/review-locally.ts plume-works/images 42
```

It builds the reviewer image unless `--image <ref>` names one, keeps the reviewer container
(`docker logs <container>` shows the transcript), and exits non-zero when the result is
unusable or a comment is off the pull request's diff.
