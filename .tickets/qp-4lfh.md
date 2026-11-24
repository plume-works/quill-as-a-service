---
id: qp-4lfh
status: open
deps: []
links: []
created: 2026-11-24T06:15:22Z
type: bug
priority: 3
tags: [review, queue]
---
# A review replaced while it posts removes request-ai-review

`request-ai-review` is on the pull request, and review A is inside the POST of its result. A push that still carries the label replaces A: `src/queue.ts::ReviewQueue.place` → `ReviewQueue.end(key, 'replaced')` aborts A. `src/review.ts::Review.post` checks `signal.aborted` only before the POST, so A returns `'success'`, and `Review.finish` removes the label, which a replaced review is meant to leave.

If the author pushes again while the replacing review B runs, that `synchronize` has no label, so `src/decide.ts::cancelsReview` cancels B, and the newest head is not reviewed. The window is as long as A's POST, so this is unlikely.

## Design

In `Review.finish`, skip removing the label when the signal was aborted with a `replaced` reason, even when the post succeeded.

