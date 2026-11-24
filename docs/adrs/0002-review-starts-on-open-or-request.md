# A review starts on open or on request

Status: proposed

The AI reviewer reviews a pull request when it opens, is reopened, or leaves
draft, and when `request-ai-review` is added. It never reviews on a push alone.
A new review withdraws the reviewer's earlier approval. A push does not: the
approval stays on the pull request until a new review starts.

## Considered Options

- A review on each push. Rejected: a busy pull request costs a model run for
  each push.
- Withdraw the approval on each push. Rejected: every push would then need a
  new review to merge, which costs what a review on each push costs.
- Assign the App or request it as a reviewer. Rejected: GitHub allows neither
  for a GitHub App.

## Consequences

- Commits pushed after the reviewer's approval merge under that approval unless
  someone adds `request-ai-review` or the ruleset dismisses stale approvals.
