import DiffMatchPatch from 'diff-match-patch';

export type DiffSegment = { text: string; type: 'same' | 'added' | 'removed' };

const dmp = new DiffMatchPatch();

export function computeWordDiff(a: string, b: string): { left: DiffSegment[]; right: DiffSegment[] } {
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);

  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      left.push({ text, type: 'same' });
      right.push({ text, type: 'same' });
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      left.push({ text, type: 'removed' });
    } else {
      right.push({ text, type: 'added' });
    }
  }

  return { left, right };
}
