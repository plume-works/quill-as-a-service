# quill-as-a-service

Quill reviews the pull requests of the repositories in its configuration. A GitHub App
(`plume-works-quill`) sends it `pull_request` webhooks; the service decides whether to review,
and runs each review in a reviewer container that checks out the head and runs Claude Code
with the `agentdev:pr-review` skill. Each review reports a `Quill Review` check run.

- `src/`: the Bun service; `test/`: its tests (`bun test`).
- `reviewer/`: the reviewer image; `tests/`: its entrypoint's tests (`uv run pytest`).
- `service/`: the service image, run under sysbox.
- [docs/deploy.md](docs/deploy.md): deploying and operating the service.
- [docs/plans/](docs/plans/): the plans of the work on the service.
- [docs/adrs/](docs/adrs/): the decisions the service follows.
