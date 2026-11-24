---
id: qp-2bce
status: open
deps: []
links: []
created: 2026-11-24T05:55:09Z
type: bug
priority: 1
tags: [security, review]
---
# Quill posts APPROVE straight from the reviewer's result

The reviewer container decides whether Quill approves a pull request. `src/review.ts::parseResult` accepts any of `APPROVE`, `REQUEST_CHANGES` and `COMMENT` from `/review/result.json`, and `src/review.ts::Review.post` posts the result under Quill's token with no further check.

The reviewer's model reads content the pull request author controls: the diff, title, body and checked-out files. If planted instructions steer it into writing an `APPROVE` result, Quill approves the pull request. Under ADR-0001 that approval satisfies the required-approval gate, so someone with write access could merge their own change with no human review. ADR-0003 moved the post into the service so the container holds no token that can approve. The approve decision itself still comes from the container.

Auto mode (plume-works/quill-as-a-service#2) screens the model's tool calls. It does not screen what the model writes as its verdict.

## Design

- The service never posts `APPROVE` from a container result. It downgrades `APPROVE` to `COMMENT`, and approval stays with humans or trusted-bot rules.
- Quill's approval stops counting toward the required approval, which reopens ADR-0001.
- The service approves only when an independent check agrees, such as a second reviewer run that never sees the PR body.

