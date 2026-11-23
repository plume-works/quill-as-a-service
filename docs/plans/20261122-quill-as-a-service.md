# Build quill-as-a-service

## Context

The AI review runs today as agent-devcontainer's
`.github/workflows/ai-responder.yml` with two actions. Each repository that wants it keeps a copy of the workflow, its
actions, an environment, secrets, and labels, and each review replays the Dev
Container lifecycle from the pull request's checkout. The user decided to
replace the workflow with a deployed service that reviews the pull requests of
repositories where its GitHub App is installed. The service is a review service
in its own right; it does not carry over the workflow's per-repository copies,
environments, or Dev Container lifecycle replay.

The service lives in this repository. Its first user is `plume-works/images`.
[Switch agent-devcontainer's AI review to quill-as-a-service](https://github.com/plume-works/agent-devcontainer/blob/main/docs/knowledge/data/plans/20261122-switch-agentdev-review-to-quill.md)
follows once this plan ships. Paths in this plan are in this repository, unless
they are named as agent-devcontainer's.

## Approach

The repository builds two images.

- The **reviewer image**, `FROM ghcr.io/plume-works/core`, installs the
  `agentdev` plugin of `plume-works/agent-devcontainer` at a pinned commit, and
  the reviewer settings. Its entry command checks out one head commit and runs
  Claude Code headless with the review prompt. The image's `quill-review`
  skill, a copy of agent-devcontainer's `pr-review` stripped to what Quill
  needs, writes the review — its event, its body, and its inline comments — to
  `/review/result.json` in the container and posts nothing. A skill Quill
  changes is copied into `reviewer/skills/` as-is first, with the
  agent-devcontainer commit it came from recorded, so it can be diffed with its
  source; the rest of the `agentdev` plugin is used as installed. The entry command exits non-zero when Claude
  fails or hits the spend limit.
- The **service image**, `FROM ghcr.io/plume-works/core-systemd`, runs under
  sysbox behind the reverse proxy of agent-devcontainer's
  `docker/deploy/README.md`. A Bun server
  verifies each webhook of the Quill App, keeps only `pull_request` events of
  repositories in its configuration, decides, and runs reviewer containers on
  its nested engine through a queue.

The configuration holds the repositories to review, the trusted bots, a pause
switch, and the maximum number of concurrent reviews (default 5). Secrets — the
App private key, the webhook secret, and the Claude OAuth token — sit in an env
file on the host. Each reviewer container gets the Claude token and an
installation token limited to its one repository that can only read
(Contents: read, Pull requests: read), never the App key
([ADR-0003](../adrs/0003-the-service-posts-the-review.md)).

The service alone writes to GitHub. When a reviewer container exits 0, the
service copies `/review/result.json` out of the stopped container and, unless
the review was cancelled by then, posts one pull request review with the
result's event, body, and comments and the reviewed head as its `commit_id`. A
review is cancelled only before that post: a push that arrives during the post
leaves the posted review on the commit it reviewed, as it leaves a review that
finished a moment earlier. A missing or malformed result, or a review GitHub
refuses, completes the check run as failure and posts nothing.

Reviewer containers run without `--rm`: a finished container is the review's
log, transcript included. core-systemd's daily cleanup removes it once it has
been stopped for a week, at the ages the service image sets
([plume-works/images#79](https://github.com/plume-works/images/pull/79)).

Review rules ([ADR-0002](../adrs/0002-review-starts-on-open-or-request.md)): a
same-repository pull request that opens, is reopened, or leaves draft, or gets
`request-ai-review` from a person with write access, is reviewed, unless it is a
draft, is from a bot, carries `block-ai-reviews`, or the service is paused. A
push while the label is on cancels the running review of that pull request and
queues one for the new head. A pull request has at most one review at a time: a
new one cancels the earlier one first. Each review creates a `Quill Review`
check run on its head when it is queued, sets it in progress when its container
starts, and completes it with the container's outcome. On start the review
dismisses Quill's earlier approval and leaves an earlier change request. After a
successful or failed review, the service removes `request-ai-review`; a
cancelled review leaves it.

Bypass auto-approvals
([ADR-0001](../adrs/0001-required-approval-is-the-only-ai-review-gate.md)) port
`review-gate.js::botApprovalFailure`: a pull request from a configured trusted
bot whose every push and commit is the bot's is approved without a review, and
an earlier approval is dismissed when that stops holding.

Assumptions: the check run is named `Quill Review`; a review container is
stopped after 30 minutes, as the workflow's `timeout-minutes: 30`; the review
prompt is the one agent-devcontainer's
`.github/workflows/ai-responder.yml#jobs.preflight` builds in
its "Determine agent prompts" step, naming `quill-review` and its result
file; `/review/result.json` holds one JSON object,
`{"event": "APPROVE" | "REQUEST_CHANGES" | "COMMENT", "body": "...",
"comments": [{"path": "...", "line": 1, "side": "RIGHT", "body": "..."}]}`, the
fields of GitHub's create-review request.

## Implementation Steps

### Task 1: Create the repository

**Closed by:** a maintainer of the `plume-works` organization.

- [x] `plume-works/quill-as-a-service` exists.
- [x] Renovate is enabled on `plume-works/quill-as-a-service`.

### Task 2: Configure the Quill App

**Closed by:** a maintainer of the `plume-works` organization.

- [ ] The Quill App has the Checks: write permission.
- [ ] The Quill App is subscribed to `pull_request` events and sends them to the
  service's URL with a webhook secret.

### Task 3: Build the reviewer image

**Files:** Create: `reviewer/Dockerfile`, `reviewer/settings.json`,
`reviewer/review.py`, `tests/test_review.py`

- [x] `reviewer/Dockerfile` builds `FROM ghcr.io/plume-works/core` by tag and
  digest and installs the `agentdev` plugin from
  `plume-works/agent-devcontainer` at a pinned commit SHA.
- [x] `reviewer/settings.json` enables the `agentdev` plugin and denies the
  tools that agent-devcontainer's
  `.github/workflows/ai-responder.yml#env.CLAUDE_PR_REVIEW_DISALLOWED_TOOLS`
  denies.
- [x] `reviewer/review.py` checks out the given head SHA and runs Claude Code
  headless with the review prompt; `uv run pytest tests/test_review.py` passes with
  a stubbed `claude`.
- [x] With a stubbed `claude` that exits non-zero, `reviewer/review.py` exits
  non-zero; `uv run pytest tests/test_review.py` passes.
- [x] With a stubbed `claude` that exits 0 and prints the spend-limit message,
  `reviewer/review.py` exits non-zero; `uv run pytest tests/test_review.py` passes.
- [x] With a stubbed `claude` whose plugin list has no `agentdev` plugin,
  `reviewer/review.py` exits non-zero before it starts a review;
  `uv run pytest tests/test_review.py` passes.

### Task 4: Load the configuration

**Files:** Create: `src/config.ts`, `test/config.test.ts`

- [x] `src/config.ts` reads the repositories, trusted bots, pause switch, and
  maximum concurrent reviews, with 5 as the default maximum;
  `bun test test/config.test.ts` passes.

### Task 5: Take signed webhooks

**Files:** Create: `src/server.ts`, `src/webhook.ts`, `test/webhook.test.ts`

- [x] A delivery whose signature does not match the webhook secret gets 401;
  `bun test test/webhook.test.ts` passes.
- [x] An event other than `pull_request` is ignored;
  `bun test test/webhook.test.ts` passes.
- [x] A `pull_request` event from a repository not in the configuration is
  ignored; `bun test test/webhook.test.ts` passes.

### Task 6: Decide whether to review

**Files:** Create: `src/decide.ts`, `test/decide.test.ts`

- [x] A same-repository pull request that opens is reviewed;
  `bun test test/decide.test.ts` passes.
- [x] A same-repository pull request that is reopened is reviewed;
  `bun test test/decide.test.ts` passes.
- [x] A same-repository pull request that leaves draft is reviewed;
  `bun test test/decide.test.ts` passes.
- [x] `request-ai-review` added by a person with write, maintain, or admin
  access is reviewed; `bun test test/decide.test.ts` passes.
- [x] `request-ai-review` added by a person without that access is not reviewed;
  `bun test test/decide.test.ts` passes.
- [x] A pull request from a fork is not reviewed; `bun test test/decide.test.ts`
  passes.
- [x] A draft pull request is not reviewed; `bun test test/decide.test.ts`
  passes.
- [x] A pull request from a bot author is not reviewed;
  `bun test test/decide.test.ts` passes.
- [x] A pull request carrying `block-ai-reviews` is not reviewed;
  `bun test test/decide.test.ts` passes.
- [x] No pull request is reviewed while the configuration pauses the service;
  `bun test test/decide.test.ts` passes.

### Task 7: Run reviews through a queue

**Files:** Create: `src/queue.ts`, `src/reviewer.ts`, `test/queue.test.ts`

- [x] `src/queue.ts` runs at most the configured number of reviews at once;
  `bun test test/queue.test.ts` passes.
- [x] When a review ends, the oldest waiting review starts;
  `bun test test/queue.test.ts` passes.
- [x] A push while `request-ai-review` is on cancels the running review of that
  pull request; `bun test test/queue.test.ts` passes.
- [x] A push while `request-ai-review` is on cancels the waiting review of that
  pull request; `bun test test/queue.test.ts` passes.
- [x] That push queues a review of the new head; `bun test test/queue.test.ts`
  passes.
- [x] A review queued for a pull request that already has a running or waiting
  review, provoked by opening the pull request and then adding
  `request-ai-review`, cancels the earlier review before it is queued;
  `bun test test/queue.test.ts` passes.
- [x] `src/reviewer.ts` asks for an installation token limited to the one
  repository; `bun test test/queue.test.ts` passes.
- [x] A reviewer container still running after 30 minutes is stopped, provoked
  in the test with a fake clock and a container that never exits;
  `bun test test/queue.test.ts` passes.
- [x] `src/reviewer.ts` starts each reviewer container without `--rm`, so it
  stays after it ends; `bun test test/queue.test.ts` passes.

### Task 8: Report each review as a check run

**Files:** Create: `src/review.ts`, `test/review.test.ts`

- [x] A queued review creates a queued `Quill Review` check run on its head;
  `bun test test/review.test.ts` passes.
- [x] The check run turns in progress when the container starts;
  `bun test test/review.test.ts` passes.
- [x] A container that exits 0 completes the check run as success;
  `bun test test/review.test.ts` passes.
- [x] A container that exits non-zero completes the check run as failure;
  `bun test test/review.test.ts` passes.
- [x] A container stopped at the timeout, provoked in the test with a fake clock
  and a container that never exits, completes the check run as failure;
  `bun test test/review.test.ts` passes.
- [x] A review cancelled by a push completes the check run as cancelled;
  `bun test test/review.test.ts` passes.
- [x] A starting review dismisses Quill's earlier approval and leaves an earlier
  change request; `bun test test/review.test.ts` passes.
- [x] A review that ends with success removes `request-ai-review`;
  `bun test test/review.test.ts` passes.
- [x] A review that ends with failure removes `request-ai-review`;
  `bun test test/review.test.ts` passes.
- [x] A review cancelled by a push leaves `request-ai-review`;
  `bun test test/review.test.ts` passes.

### Task 9: Approve trusted-bot pull requests

**Files:** Create: `src/approve.ts`, `test/approve.test.ts`

- [x] A pull request from a configured trusted bot whose every push and commit
  satisfies `review-gate.js::botApprovalFailure`'s rule is approved once by
  Quill; `bun test test/approve.test.ts` passes.
- [x] A push from anyone other than the bot dismisses Quill's approval;
  `bun test test/approve.test.ts` passes.
- [x] A commit authored by anyone other than the bot dismisses Quill's approval;
  `bun test test/approve.test.ts` passes.
- [x] `test/approve.test.ts` carries the cases of
  agent-devcontainer's `.github/actions/ai-review-status/review-gate.test.js`
  that cover
  `botApprovalFailure`.

### Task 10: Build the service image

**Files:** Create: `service/Dockerfile`

- [x] `service/Dockerfile` builds `FROM ghcr.io/plume-works/core-systemd` by tag
  and digest and runs the Bun server as a systemd unit.
- [x] `service/Dockerfile` pins a `core-systemd` that has the configurable
  cleanup of
  [plume-works/images#79](https://github.com/plume-works/images/pull/79) and
  installs a `docker-prune.service.d` drop-in that sets every `PRUNE_*` setting:
  `168h` for stopped containers, anonymous volumes, images and build cache,
  `off` for named volumes.

### Task 11: Write the deployment

**Files:** Create: `compose.yml`, `service.env.example`, `docs/deploy.md`

- [x] `compose.yml` runs the service image under the sysbox runtime on the proxy
  network and publishes no host port.
- [x] `docs/deploy.md` gives the steps from an empty host to a running service.

### Task 12: Build and test in CI

**Files:** Create: `.github/workflows/ci.yml`

- [x] `.github/workflows/ci.yml` runs `bun test` on pull requests.
- [x] `.github/workflows/ci.yml` builds both images on pull requests.
- [x] `.github/workflows/ci.yml` publishes both images to `ghcr.io/plume-works`
  only from `main`.

### Task 13: Keep the pins current

**Files:** Create: `renovate.json`

- [x] `renovate.json` has rules that match the `core` and `core-systemd` digests
  and the `agent-devcontainer` commit pin.

### Task 14: Adapt pr-review as quill-review

**Files:** Create: `reviewer/skills/README.md`,
`reviewer/skills/quill-review/SKILL.md`

- [x] `reviewer/skills/README.md` names the agent-devcontainer commit that
  `quill-review` was copied from, and a commit holds that copy unchanged.
- [x] `reviewer/skills/quill-review/SKILL.md` writes its event, body, and inline
  comments to the result file the prompt names, in the shape `## Approach`
  gives, and posts nothing to GitHub.

### Task 15: Have the reviewer write its result

**Files:** Modify: `reviewer/Dockerfile`, `reviewer/review.py`,
`tests/test_review.py`

- [x] `reviewer/Dockerfile` installs `reviewer/skills/quill-review` as a user
  skill of the user Claude runs as.
- [x] `reviewer/Dockerfile` creates `/review`, writable by the user Claude runs
  as.
- [x] The prompt `reviewer/review.py` gives Claude asks `quill-review` for
  `/review/result.json`;
  `uv run pytest tests/test_review.py` passes with a stubbed `claude` that
  records its prompt.

### Task 16: Post the review from the service

**Files:** Modify: `src/reviewer.ts`, `src/review.ts`, `src/server.ts`,
`test/review.test.ts`, `test/queue.test.ts`

- [x] `src/reviewer.ts` copies `/review/result.json` out of a reviewer container
  that exited 0; `bun test test/queue.test.ts` passes with a fake engine.
- [x] A review whose container exits 0 with a valid result posts one pull
  request review with the result's event, body, and comments and the reviewed
  head as `commit_id`, then completes the check run as success;
  `bun test test/review.test.ts` passes.
- [x] A review whose container exits 0 without a result file completes the
  check run as failure and posts no review; `bun test test/review.test.ts`
  passes.
- [x] A review whose result is malformed completes the check run as failure and
  posts no review; `bun test test/review.test.ts` passes.
- [x] A review GitHub refuses to create completes the check run as failure,
  provoked with a fake GitHub that answers the post with 422;
  `bun test test/review.test.ts` passes.
- [x] A review cancelled while its container exits posts no review, provoked
  with a container run that resolves after the cancel;
  `bun test test/review.test.ts` passes.
- [x] A review cancelled by a push dismisses no approval;
  `bun test test/review.test.ts` passes.

### Task 17: Give the reviewer a read-only token

**Files:** Modify: `src/reviewer.ts`, `test/queue.test.ts`, `docs/deploy.md`,
`README.md`

- [x] `src/reviewer.ts` asks for an installation token with Contents: read and
  Pull requests: read only; `bun test test/queue.test.ts` passes.
- [x] `docs/deploy.md` says that the reviewer container's token only reads and
  that the service posts the review.
- [x] `README.md` says that the service posts the review the reviewer container
  writes.

### Task 18: Review a pull request locally

**Files:** Create: `scripts/review-locally.ts`, `test/review-locally.test.ts`;
Modify: `tsconfig.json`, `README.md`

- [x] `scripts/review-locally.ts` runs the reviewer image for one pull request on
  the local Docker engine through `src/reviewer.ts::runContainer`, reads its
  result through `src/reviewer.ts::readResult` and
  `src/review.ts::parseResult`, and posts nothing.
- [x] `scripts/review-locally.ts` reports each comment of the result that is not
  on a line of the pull request's diff; `bun test test/review-locally.test.ts`
  passes.
- [x] `README.md` gives the command and the two tokens it reads.

### Task 19: Run a live review locally

**Closed by:** a maintainer running `scripts/review-locally.ts` with a Claude
token and a read-only GitHub token.

- [ ] A live review of a real pull request writes a result
  `src/review.ts::parseResult` accepts.
- [ ] Every comment of that result is on a line of the pull request's diff.

### Task 20: Publish the images

**Closed by:** the first CI run on `main` of `plume-works/quill-as-a-service`.

- [ ] The service image and the reviewer image are on `ghcr.io/plume-works`.

### Task 21: Deploy the service

**Closed by:** a maintainer deploying the service on a sysbox host.

- [ ] The service answers the Quill App's webhook deliveries with success.

### Task 22: Onboard plume-works/images

**Closed by:** a maintainer adding `plume-works/images` to the configuration and
installing the Quill App on it, then watching its pull requests.

- [ ] A pull request opened on `plume-works/images` gets a review by
  `plume-works-quill[bot]`.
- [ ] That pull request gets a completed `Quill Review` check on its head.
- [ ] Adding `request-ai-review` starts a review.
- [ ] The label is gone when that review ends.
- [ ] A push while `request-ai-review` is on cancels the running review.
- [ ] A review of the new head follows that push.
- [ ] After Quill approves a pull request, adding `request-ai-review` starts a
  review that dismisses that approval.
- [ ] A Renovate pull request is approved by Quill without a review.

## Acceptance

### Scenario: An unsigned delivery is refused

- **WHEN** a webhook delivery's signature does not match the webhook secret
- **THEN** the service answers 401 and acts on nothing
- **Test:** `test/webhook.test.ts::rejects a delivery with a bad signature`

### Scenario: A repository outside the configuration is ignored

- **WHEN** a `pull_request` event comes from a repository that has the App
  installed but is not in the configuration
- **THEN** no review is queued and no check run is created
- **Test:**
  `test/webhook.test.ts::ignores a repository outside the configuration`

### Scenario: Opening a pull request starts a review

- **WHEN** a same-repository pull request that is not a draft opens, is
  reopened, or leaves draft
- **THEN** a review of its head is queued
- **Test:**
  `test/decide.test.ts::reviews on opened, reopened, and ready_for_review`

### Scenario: The request label from a writer starts a review

- **WHEN** a person with write, maintain, or admin access adds
  `request-ai-review`
- **THEN** a review of the head is queued, and a person without that access
  adding the label queues nothing
- **Test:**
  `test/decide.test.ts::reviews on the request label from a writer only`

### Scenario: Forks, drafts, and bots get no review

- **WHEN** a pull request comes from a fork, is a draft, or is authored by a bot
- **THEN** no review is queued
- **Test:** `test/decide.test.ts::skips forks, drafts, and bot authors`

### Scenario: The block label and the pause switch stop reviews

- **WHEN** the pull request carries `block-ai-reviews`, or the configuration
  pauses the service
- **THEN** no review is queued
- **Test:**
  `test/decide.test.ts::skips blocked pull requests and a paused service`

### Scenario: A pull request has at most one review at a time

- **WHEN** a review is queued for a pull request that already has a running or
  waiting review
- **THEN** the earlier review is cancelled first, so it leaves
  `request-ai-review` on and only the newest review removes it
- **Test:**
  `test/queue.test.ts::a new review of a pull request cancels its earlier review`

### Scenario: A finished reviewer container is kept

- **WHEN** a review ends with success or failure, is stopped at the timeout, or
  is cancelled
- **THEN** its reviewer container stays on the service's engine, transcript
  included, until core-systemd's cleanup removes it
- **Test:** `test/queue.test.ts::a reviewer container is started without --rm`

### Scenario: A push during a requested review restarts it

- **WHEN** a push arrives while `request-ai-review` is on the pull request
- **THEN** the running or waiting review of that pull request is cancelled and a
  review of the new head is queued
- **Test:**
  `test/queue.test.ts::a push with the label on restarts the review on the new head`

### Scenario: Reviews beyond the limit wait

- **WHEN** more reviews are queued than the configured maximum, 5 by default
- **THEN** only the maximum run at once, the others wait with a queued check
  run, and the oldest waiting one starts when a running one ends
- **Test:**
  `test/queue.test.ts::runs at most the maximum and starts the oldest waiting`

### Scenario: Each review reports a check run on its head

- **WHEN** a review is queued, starts, and ends
- **THEN** its `Quill Review` check run on the reviewed head goes queued, in
  progress, and completes as success for exit 0, failure for a non-zero exit or
  the 30-minute timeout, and cancelled when it was cancelled
- **Test:** `test/review.test.ts::the check run follows the review`

### Scenario: A new review dismisses Quill's earlier approval

- **WHEN** a review starts on a pull request where Quill's latest review
  approved, or requested changes
- **THEN** the approval is dismissed, and the change request stays
- **Test:**
  `test/review.test.ts::a starting review dismisses the earlier approval only`

### Scenario: The request label is taken when the review ends

- **WHEN** a review ends with success or failure, or is cancelled
- **THEN** the service removes `request-ai-review` after success or failure, and
  leaves it after a cancel
- **Test:**
  `test/review.test.ts::the label is removed after success or failure only`

### Scenario: A trusted bot's pull request is approved without a review

- **WHEN** a pull request from a configured trusted bot has only the bot's
  pushes and the bot's verified commits, or gains a push or commit from anyone
  else
- **THEN** Quill approves it once without a review, and in the second case
  dismisses that approval
- **Test:**
  `test/approve.test.ts::approves a trusted bot and withdraws on a foreign push`

### Scenario: The reviewer fails on the spend limit

- **WHEN** Claude reports the organization's spend limit during a review
- **THEN** `reviewer/review.py` exits non-zero, so the check run fails
- **Test:** `tests/test_review.py::test_exits_non_zero_on_the_spend_limit`

### Scenario: The reviewer refuses to review without its catalog

- **WHEN** the `agentdev` plugin, and with it the skills `quill-review` calls,
  is not available in the reviewer container
- **THEN** `reviewer/review.py` exits non-zero before Claude reviews, so the
  service posts no review and the check run fails
- **Test:**
  `tests/test_review.py::test_exits_non_zero_when_the_agentdev_plugin_is_missing`

### Scenario: The service posts the reviewer's result on the reviewed commit

- **WHEN** a reviewer container exits 0 with a valid `/review/result.json` and
  the review was not cancelled
- **THEN** the service posts one review with the result's event, body, and
  comments, its `commit_id` the reviewed head, and the check run completes as
  success
- **Test:**
  `test/review.test.ts::the service posts the result on the reviewed commit`

### Scenario: A review without a usable result fails and posts nothing

- **WHEN** a reviewer container exits 0 with no result file or a malformed one,
  or GitHub refuses the review
- **THEN** the check run completes as failure, and no review is posted
- **Test:**
  `test/review.test.ts::a review without a usable result fails and posts nothing`

### Scenario: A cancelled review posts nothing

- **WHEN** a push or a newer review cancels a review before the service posts
  it, including while its container exits
- **THEN** no review is posted and no approval is dismissed for that cancel; a
  push that arrives during the post leaves the posted review on the commit it
  reviewed
- **Test:** `test/review.test.ts::a cancelled review posts nothing`

### Scenario: The reviewer container cannot write to GitHub

- **WHEN** the service asks for a reviewer container's installation token
- **THEN** the token is limited to the one repository with Contents: read and
  Pull requests: read
- **Test:**
  `test/queue.test.ts::asks for a read-only installation token limited to the one repository`

### Scenario: Quill reviews a pull request on plume-works/images

- **WHEN** the reviewer image runs for a pull request on `plume-works/images`
- **THEN** a review by `plume-works-quill[bot]` names the head commit
- **Checked at ship:**
  `docs/plans/20261122-quill-as-a-service.md#task-22-onboard-plume-worksimages`

## Verification

Run every test that `## Acceptance` names:

``` bash
bun install --frozen-lockfile && bun test
uv run --frozen pytest
```

## Out of scope

- Switching agent-devcontainer from the workflow to the service; [Switch
  agent-devcontainer's AI review to quill-as-a-service](https://github.com/plume-works/agent-devcontainer/blob/main/docs/knowledge/data/plans/20261122-switch-agentdev-review-to-quill.md) holds it.
- `merge_group` events; the service checks pull request heads only.
- Comment and mention triggers, and reviews on each push.
- Keeping review transcripts beyond the container's lifetime.
- An automated test that runs a live review; `scripts/review-locally.ts` runs one
  by hand.
- Pull requests from forks.
- Moving an inline comment GitHub cannot place into a separate comment; a
  review GitHub refuses fails.
- Changes to agent-devcontainer, including folding `quill-review` back into
  `pr-review`; they follow once this plan's pull request merges.

## Key references

In this repository:

- `src/review.ts::Review.run` — where the service will post the result.
- `src/review.ts::Review.finish` — the dismissal after a cancel by a push, which
  Task 16 removes.
- `src/reviewer.ts::REVIEWER_PERMISSIONS` — the reviewer token's permissions.
- `src/reviewer.ts::runContainer` — where the result is copied out after exit 0.
- `reviewer/review.py::PROMPT` — the review prompt.
- `reviewer/skills/quill-review/SKILL.md#steps` › "Write the result" — the
  result file the service reads.

In agent-devcontainer:

- `.github/actions/ai-review-status/review-gate.js::botApprovalFailure` — the
  bypass auto-approval rule that Task 9 ports.
- `.github/actions/ai-review-status/review-gate.js::wantsReview` — today's label
  decision, background for Task 6.
- `.github/actions/ai-review-status/review-gate.test.js` — the cases Task 9
  keeps.
- `.github/workflows/ai-responder.yml#jobs.trusted-bot-approval` › "Approve on
  behalf of the trusted bot" — how the approval reads the push history and
  commits.
- `.github/workflows/ai-responder.yml#jobs.preflight` › "Determine agent
  prompts" — the review prompt.
- `.github/workflows/ai-responder.yml#env.CLAUDE_PR_REVIEW_DISALLOWED_TOOLS` —
  the tools the reviewer settings deny.
- `.github/actions/run-claude-responder/action.yml` › "Fail on Claude usage
  limit" — the spend-limit message the reviewer detects.
- `docker/deploy/README.md#1-create-the-proxy-network` — the reverse-proxy
  pattern the deployment follows.
