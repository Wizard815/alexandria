// Copied from Wizard815/DND-Spell-Tree src/tree/icons.tsx by scripts/sync-alexandria.sh: change it there.
// Small glyphs for the spell tree: one per element (fire, cold...) and one per
// school of magic. A spell shows its element's glyph, or its school's when it
// has no element. Each glyph is drawn in a 24 by 24 box centred on 12,12.
// No imports from the rest of the app: this folder is copied into Alexandria.
import type { TreeSpell } from './types.ts';

interface Glyph { d: string; fill?: boolean; evenodd?: boolean }

const SKULL: Glyph = { d: 'M12 3a7 7 0 0 0-7 7v3.5l2 2V19h10v-3.5l2-2V10a7 7 0 0 0-7-7zM9 9.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM15 9.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z', fill: true, evenodd: true };

export const ELEMENT_GLYPH: Record<string, Glyph> = {
  Fire: { d: 'M12 2.5c1.2 4.2 5.5 5.6 5.5 10.6a5.5 5.5 0 0 1-11 0c0-3 1.8-4.4 2.3-6.4 1 1.1 1.8 2.2 1.9 3.4 1.2-2.2 1.6-4.6 1.3-7.6z', fill: true },
  Cold: { d: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M10 4.5l2 2 2-2M10 19.5l2-2 2 2' },
  Lightning: { d: 'M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z', fill: true },
  Thunder: { d: 'M8.5 8.5a5 5 0 0 0 0 7M5.5 5.5a9.5 9.5 0 0 0 0 13M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9.5 9.5 0 0 1 0 13M12 10.5v3' },
  Acid: { d: 'M12 3c3 4.6 6 7.6 6 11.4a6 6 0 0 1-12 0C6 10.6 9 7.6 12 3zM10 13.5a1.5 1.5 0 1 0 0.01 0z', fill: true, evenodd: true },
  Poison: { d: 'M9.5 3h5M10.5 3v5.5L5.6 17a3 3 0 0 0 2.6 4.5h7.6a3 3 0 0 0 2.6-4.5l-4.9-8.5V3M8 15h8' },
  Necrotic: SKULL,
  Radiant: { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z' },
  Force: { d: 'M12 2.5l8.5 9.5-8.5 9.5L3.5 12zM12 7.5l4 4.5-4 4.5-4-4.5z' },
  Psychic: { d: 'M12 12m-1.2 0a1.2 1.2 0 1 1 2.4 0a3.4 3.4 0 1 1-6.8 0a5.6 5.6 0 1 1 11.2 0a7.8 7.8 0 1 1-15.6 0' },
  Bludgeoning: { d: 'M5 9h10v6H5zM15 12h5M9 15v6' },
  Piercing: { d: 'M4 20L19 5M19 5h-6.5M19 5v6.5' },
  Slashing: { d: 'M5 17L17 5M8.5 20L20 8.5' },
};

export const SCHOOL_GLYPH: Record<string, Glyph> = {
  Abjuration: { d: 'M12 2.5l8 3v6c0 5-3.5 8.6-8 10.5-4.5-1.9-8-5.5-8-10.5v-6z' },
  Conjuration: { d: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 7.5l1.4 3.1 3.1 1.4-3.1 1.4L12 16.5l-1.4-3.1L7.5 12l3.1-1.4z' },
  Divination: { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z' },
  Enchantment: { d: 'M12 20.5S3.5 15.5 3.5 9a4.3 4.3 0 0 1 8.5-1 4.3 4.3 0 0 1 8.5 1c0 6.5-8.5 11.5-8.5 11.5z' },
  Evocation: { d: 'M12 2l2.6 6.4 6.9.6-5.3 4.5 1.6 6.8L12 16.6l-5.8 3.7 1.6-6.8L2.5 9l6.9-.6z', fill: true },
  Illusion: { d: 'M15 2.8a9.4 9.4 0 1 0 6.2 15.6A7.6 7.6 0 0 1 15 2.8z', fill: true },
  Necromancy: SKULL,
  Transmutation: { d: 'M12 4l8 14H4zM12 9.5a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4z' },
  Others: { d: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z' },
};

/** The glyph a spell shows: its first element's, else its school's. */
export function glyphFor(s: Pick<TreeSpell, 'lines' | 'school'>): { key: string; g: Glyph } {
  const el = s.lines.find((l) => ELEMENT_GLYPH[l]);
  if (el) return { key: el, g: ELEMENT_GLYPH[el] };
  const sc = SCHOOL_GLYPH[s.school] ? s.school : 'Others';
  return { key: sc, g: SCHOOL_GLYPH[sc] };
}

/** A glyph inside an SVG, `size` units wide, centred on 0,0. */
export function GlyphMark({ g, size, className }: { g: Glyph; size: number; className?: string }) {
  const k = size / 24;
  return (
    <path className={className} d={g.d} transform={`scale(${k}) translate(-12,-12)`}
      fill={g.fill ? 'currentColor' : 'none'} fillRule={g.evenodd ? 'evenodd' : undefined}
      stroke={g.fill ? 'none' : 'currentColor'} strokeWidth={g.fill ? 0 : 2.2} strokeLinecap="round" strokeLinejoin="round" />
  );
}

/** A glyph as its own small inline SVG, for keys and lists. */
export function GlyphIcon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const g = ELEMENT_GLYPH[name] ?? SCHOOL_GLYPH[name] ?? SCHOOL_GLYPH.Others;
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true" style={{ color, flex: 'none' }}>
      <GlyphMark g={g} size={24} />
    </svg>
  );
}
