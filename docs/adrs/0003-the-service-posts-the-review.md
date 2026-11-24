# The service posts the review; the reviewer only reads

Status: proposed

The reviewer container reviews a pull request and writes its result to a file:
the event, the body, and the inline comments. The service reads that file and
posts the review with its own token, pinned to the reviewed commit. The
reviewer's installation token can only read the pull request's repository.

## Considered Options

- The reviewer posts its own review. Rejected: the container runs the model
  over the author's code with a token that can approve, and the service cannot
  withhold a review it has cancelled.

## Consequences

- Whether a review is posted is decided in one place, after the container has
  exited.
- A review GitHub refuses, such as one with a comment outside the diff, fails
  instead of being posted in parts.
