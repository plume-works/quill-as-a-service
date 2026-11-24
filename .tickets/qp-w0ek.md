---
id: qp-w0ek
status: open
deps: []
links: []
created: 2026-11-24T06:15:22Z
type: bug
priority: 3
tags: [security, approve]
---
# A lost push delivery leaves a trusted bot's approval on a foreign commit

Quill has approved a trusted bot's pull request, and someone pushes a foreign commit to its branch. `src/approve.ts::approveTrustedBot` dismisses the approval only once the `synchronize` delivery for that push is handled and its GitHub calls (reviews, activity, commits) succeed. If the delivery is lost, nothing dismisses the approval:

- a GitHub call answers 5xx or hits a rate limit, and the `.catch` in `src/server.ts::handlePullRequest` only logs it;
- the service is restarting or down when GitHub sends the webhook, and GitHub does not redeliver on its own.

`src/reconcile.ts::reconcile` re-checks only `Quill Review` check runs, not trusted-bot approvals. The approval then satisfies the required approval (ADR-0001) for a commit no human reviewed.

## Design

- At start, have `reconcile` re-check the open trusted-bot pull requests that Quill has approved.
- Retry `approveTrustedBot` after an error.
- Or rely on the ruleset dismissing stale approvals on push.

