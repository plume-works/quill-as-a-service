import { describe, expect, test } from 'bun:test';
import type { ReviewResult } from '../src/review';
import { commentableLines, offTheDiff } from '../scripts/review-locally';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ export function a() {
 const kept = 1;
-const removed = 2;
+const added = 2;
+const more = 3;
 return kept;
diff --git a/old.md b/old.md
deleted file mode 100644
--- a/old.md
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

const comment = (path: string, side: 'LEFT' | 'RIGHT', line: number) => ({ path, side, line, body: 'b' });

describe('where a review comment can go', () => {
  test('reads the lines of each side from the hunks', () => {
    const lines = commentableLines(DIFF).get('src/a.ts')!;
    expect([...lines.RIGHT]).toEqual([10, 11, 12, 13]);
    expect([...lines.LEFT]).toEqual([10, 11, 12]);
    expect([...commentableLines(DIFF).get('old.md')!.LEFT]).toEqual([1]);
  });

  test('finds the comments GitHub would refuse', () => {
    const result: ReviewResult = {
      event: 'COMMENT',
      body: '',
      comments: [comment('src/a.ts', 'RIGHT', 12), comment('src/a.ts', 'RIGHT', 20), comment('src/b.ts', 'RIGHT', 1)],
    };
    expect(offTheDiff(result, DIFF)).toEqual([comment('src/a.ts', 'RIGHT', 20), comment('src/b.ts', 'RIGHT', 1)]);
  });
});
