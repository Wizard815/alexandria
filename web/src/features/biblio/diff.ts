// A line diff (longest common subsequence) for the article history: what an
// old version had that the current one does not, and the other way round.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Very long texts: compare without the table (it would be a * b cells), line by line in place.
  if (a.length * b.length > 4_000_000) {
    const out: DiffLine[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) out.push({ kind: 'same', text: a[i] });
      else { if (a[i] !== undefined) out.push({ kind: 'del', text: a[i] }); if (b[i] !== undefined) out.push({ kind: 'add', text: b[i] }); }
    }
    return out;
  }
  const n = a.length;
  const m = b.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** The changed lines with up to `ctx` unchanged lines around each change; long unchanged runs become one "…" line. */
export function trimDiff(lines: DiffLine[], ctx = 2): (DiffLine | { kind: 'gap'; text: string })[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = i - ctx; k <= i + ctx; k++) keep.add(k); });
  const out: (DiffLine | { kind: 'gap'; text: string })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep.has(i)) { if (gap) out.push({ kind: 'gap', text: `${gap} unchanged line${gap === 1 ? '' : 's'}` }); gap = 0; out.push(l); } else gap++;
  });
  if (gap && out.length) out.push({ kind: 'gap', text: `${gap} unchanged line${gap === 1 ? '' : 's'}` });
  return out;
}
