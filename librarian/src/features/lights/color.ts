// Colour helpers for the lights: hex parsing, the Hue xy conversion and the
// colour a music mood maps to.
export type RGB = [number, number, number];

export function parseColor(v: unknown): RGB | null {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = (c: RGB): string => '#' + c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

/** sRGB to the CIE xy a Hue bridge takes (wide gamma-corrected conversion). */
export function rgbToXy([r8, g8, b8]: RGB): [number, number] {
  const lin = (c: number) => { const v = c / 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum <= 0) return [0.3227, 0.329];
  return [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000];
}

/** The corners of the sound board's mood map, as light colours. */
export const MOOD_COLORS: Record<string, RGB> = {
  calm: [63, 167, 214],
  tense: [232, 163, 61],
  sneaky: [107, 79, 187],
  combat: [214, 40, 40],
};

/** A colour for a spot on the mood map (x left to right, y top to bottom): a blend of the four corners. */
export function moodColor(x: number, y: number): RGB {
  const cx = Math.min(1, Math.max(0, x)), cy = Math.min(1, Math.max(0, y));
  const w = { calm: (1 - cx) * (1 - cy), tense: cx * (1 - cy), sneaky: (1 - cx) * cy, combat: cx * cy };
  const out: RGB = [0, 0, 0];
  for (const [k, wt] of Object.entries(w)) for (let i = 0; i < 3; i++) out[i] += MOOD_COLORS[k][i] * wt;
  return [Math.round(out[0]), Math.round(out[1]), Math.round(out[2])];
}
