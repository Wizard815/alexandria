// Version ranges for house rule manifests: the Alexandria versions a rule is
// built for and the versions of other rules it needs. A small subset of npm's
// ranges, enough for packages people write by hand:
//   "*"  "1.2.0"  "=1.2.0"  ">=0.2"  ">1"  "<=1.4"  "<2"  "^1.2"  "~1.2.3"
//   several in a row all apply (">=1.2 <2"), "||" means either.
// Only major.minor.patch counts: a pre-release (0.1.0-alpha.1) compares as its
// release, so a rule for ">=0.1" runs on the alpha.

export type Ver = [number, number, number];

/** "1.2" → [1, 2, 0]; null when it is not a version. */
export function parseVer(v: string): Ver | null {
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

const cmp = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

type Test = (v: Ver) => boolean;

function comparator(c: string): Test | null {
  if (c === '*' || c === 'x' || c === '') return () => true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? '=';
  const raw = m[2];
  const parts = raw.replace(/^v/, '').split(/[-+]/)[0].split('.');
  const b = parseVer(raw);
  if (!b) return null;
  const given = parts.length; // "1" or "1.2" or "1.2.3"
  switch (op) {
    case '>=': return (v) => cmp(v, b) >= 0;
    case '>': return (v) => cmp(v, b) > 0;
    case '<=': return (v) => cmp(v, b) <= 0;
    case '<': return (v) => cmp(v, b) < 0;
    case '~': { const hi: Ver = given >= 2 ? [b[0], b[1] + 1, 0] : [b[0] + 1, 0, 0]; return (v) => cmp(v, b) >= 0 && cmp(v, hi) < 0; }
    case '^': { const hi: Ver = b[0] > 0 ? [b[0] + 1, 0, 0] : b[1] > 0 || given < 3 ? [0, b[1] + 1, 0] : [0, 0, b[2] + 1]; return (v) => cmp(v, b) >= 0 && cmp(v, hi) < 0; }
    default: // "=" or bare: a partial version matches anything under it ("1.2" = 1.2.x)
      return given >= 3 ? (v) => cmp(v, b) === 0 : given === 2 ? (v) => v[0] === b[0] && v[1] === b[1] : (v) => v[0] === b[0];
  }
}

/** A range's test, or null when it cannot be read. */
export function parseRange(range: string): Test | null {
  const r = String(range ?? '').trim();
  if (r.length > 80) return null;
  const alts = r.split('||').map((alt) => {
    const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    // An empty side of || ("^1 ||", "|| ||") is a typo, not "any version".
    if (!tokens.length && r.includes('||')) return null;
    const tests = tokens.map(comparator);
    return tests.some((t) => !t) ? null : (v: Ver) => tests.every((t) => t!(v));
  });
  if (alts.some((a) => !a)) return null;
  return (v) => alts.some((a) => a!(v));
}

/** Does this version fall in the range? A version or range that cannot be read never does. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  const t = parseRange(range);
  return !!v && !!t && t(v);
}
