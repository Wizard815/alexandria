// Copied from Wizard815/DND-Spell-Tree src/tree/treeCss.ts by scripts/sync-alexandria.sh: change it there.
// The tree's styles as a string, so the host page adds them with <style>.
// Colors come from the host's variables (--bg, --panel, --text, --muted,
// --line, --accent), the same names Alexandria's theme uses.
export const TREE_CSS = `
.st { display: flex; flex-direction: column; gap: 14px; color: var(--text); }
.st-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.st-search { flex: 1 1 200px; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; }
.st-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.st-chip { border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.st-chip[aria-pressed="true"] { background: var(--accent); color: var(--on-accent, #fff); border-color: var(--accent); }
.st-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); }
.st-legend span { display: inline-flex; align-items: center; gap: 5px; }
.st-legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.st-group { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--panel); border-left: 4px solid var(--sc, var(--line)); }
.st-group > h3 { margin: 0 0 6px; font-size: 15px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.st-group > h3 small { color: var(--muted); font-weight: 400; font-size: 12px; }
.st-hybrids { border-style: dashed; background: linear-gradient(90deg, color-mix(in srgb, var(--a, #888) 12%, var(--panel)), color-mix(in srgb, var(--b, #888) 12%, var(--panel))); }
.st-tier { display: grid; grid-template-columns: 54px 1fr; gap: 6px; align-items: start; padding: 4px 0; border-top: 1px dashed color-mix(in srgb, var(--line) 60%, transparent); }
.st-tier:first-of-type { border-top: 0; }
.st-tier > b { font-size: 11px; color: var(--muted); font-weight: 600; padding-top: 5px; text-transform: uppercase; letter-spacing: .03em; }
.st-nodes { display: flex; flex-wrap: wrap; gap: 5px; }
.st-node { position: relative; font: inherit; font-size: 12.5px; line-height: 1.2; padding: 5px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; max-width: 100%; text-align: left; overflow: hidden; }
.st-node:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.st-node[data-s="dark"], .st-node[data-s="hidden"] { background: #17161d; color: rgba(255,255,255,.38); border-color: #24222c; }
.st-node[data-s="locked"] { background: #2c2a35; color: rgba(255,255,255,.68); border-color: #3b3846; }
.st-node[data-s="learn"] { background: #8e96a4; color: #fff; border-color: #dfe3ea; box-shadow: 0 0 6px rgba(223,227,234,.55); font-weight: 600; text-shadow: 0 1px 1px rgba(0,0,0,.35); }
.st-node[data-s="studying"], .st-node[data-s="stopped"] { background: color-mix(in srgb, var(--sc, var(--accent)) 25%, var(--panel)); border-color: var(--sc, var(--accent)); }
.st-node[data-s="stopped"] { border-style: dashed; }
.st-node[data-s="known"] { background: var(--sc, var(--accent)); color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,.45); box-shadow: 0 0 8px color-mix(in srgb, var(--sc, var(--accent)) 60%, transparent); }
.st-node[data-s="gift"] { background: #b8892b; color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,.45); box-shadow: 0 0 8px rgba(232,180,80,.6); }
.st-node .st-prog { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--sc, var(--accent)); }
.st-node[aria-current="true"] { outline: 2px solid var(--text); outline-offset: 1px; }
.st-empty { color: var(--muted); font-size: 13px; }
.st-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (min-width: 980px) { .st-layout.open { grid-template-columns: minmax(0, 1fr) 380px; } .st-panel { position: sticky; top: 10px; max-height: calc(100vh - 20px); overflow: auto; } }
.st-panel { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
@media (max-width: 979px) { .st-panel { position: fixed; left: 0; right: 0; bottom: 0; max-height: 78vh; overflow: auto; border-radius: 16px 16px 0 0; z-index: 50; box-shadow: 0 -8px 30px rgba(0,0,0,.45); } }
.st-panel h2 { margin: 0; font-size: 19px; }
.st-panel h4 { margin: 0 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.st-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
.st-sub { color: var(--muted); font-size: 13px; }
.st-pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); margin-right: 4px; }
.st-miss { margin: 0; padding-left: 18px; font-size: 13px; }
.st-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.st-table th, .st-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); }
.st-table tr[aria-selected="true"] td { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.st-table td:not(:first-child), .st-table th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.st-btn { font: inherit; font-size: 14px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
.st-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent, #fff); font-weight: 600; }
.st-btn:disabled { opacity: .5; cursor: not-allowed; }
.st-btn.small { font-size: 12.5px; padding: 5px 9px; }
.st-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.st-panel label.st-row { flex-wrap: nowrap; }
.st-panel .st-row, .st-table label { display: flex; flex-direction: row; align-items: center; gap: 6px; color: inherit; }
.st-field { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.st-field input, .st-field select { font: inherit; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--text); width: 90px; }
.st-progress { height: 10px; border-radius: 999px; background: var(--line); overflow: hidden; }
.st-progress > span { display: block; height: 100%; background: linear-gradient(90deg, var(--teal, #2bb3a3), var(--accent)); }
.st-note { font-size: 13px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.st-err { font-size: 13px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, #d33 22%, transparent); }
.st-text { font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; max-height: 220px; overflow: auto; }
.st-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin: 0; font-size: 13px; }
.st-facts dt { color: var(--muted); font-size: 11.5px; } .st-facts dd { margin: 0; }
`;

/** A color per school of magic, and for the elements hybrids mix. */
export const SCHOOL_COLOR: Record<string, string> = {
  Abjuration: '#3d7bd9', Conjuration: '#d9a23d', Divination: '#9b8fe0', Enchantment: '#d95fa8',
  Evocation: '#e0523d', Illusion: '#7a5fd9', Necromancy: '#5f8a4a', Transmutation: '#3daa8f', Others: '#808a99',
};
export const ELEMENT_COLOR: Record<string, string> = {
  Fire: '#e25822', Cold: '#7fc8f8', Lightning: '#f2d43d', Thunder: '#8e7cc3', Acid: '#8fd14f', Poison: '#5fa85f',
  Necrotic: '#6b5a7a', Radiant: '#f6e27f', Force: '#c77dff', Psychic: '#e07ab8', Bludgeoning: '#a0866a', Piercing: '#a0a0a0', Slashing: '#b0705a',
};
