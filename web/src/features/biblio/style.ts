// Biblio's own styles, on top of the library's page styles (LIB_CSS).
export const BIBLIO_CSS = `
.bib .lib-link-btn { border: 0; background: none; padding: 0; color: var(--accent-strong, inherit); font: inherit; text-align: left; cursor: pointer; }
.bib .lib-link-btn.inline { display: inline; text-decoration: underline dotted; text-underline-offset: 3px; }
.bib .lib-link-btn:disabled { cursor: default; color: inherit; }
.bib-shell { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; gap: 16px; align-items: start; margin-top: 12px; }
.bib-treebtn { display: none; }
@media (max-width: 820px) {
  .bib-shell { grid-template-columns: 1fr; }
  .bib-side { position: static; max-height: none; }
  .bib-treebtn { display: inline-flex; align-self: flex-start; }
  .bib-folded .bib-side .bib-tree, .bib-folded .bib-side .bib-hits { display: none; }
}
.bib-tfield .input { width: auto; }
.bib-side { position: sticky; top: 8px; max-height: calc(100vh - 140px); overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.bib-side input[type=search] { width: 100%; }
.bib-tree, .bib-tree ul { list-style: none; margin: 0; padding: 0; }
.bib-row { display: flex; align-items: center; gap: 2px; border-radius: 6px; }
.bib-row.on { background: var(--accent-soft, rgba(200, 160, 60, .18)); }
.bib-twist { width: 18px; flex: none; background: none; border: 0; color: inherit; cursor: pointer; padding: 0; }
.bib-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; background: none; border: 0; color: inherit; text-align: left; padding: 4px 4px; cursor: pointer; font: inherit; }
.bib-open span:not(.bib-lv) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bib-lv { margin-left: auto; font-size: 10px; padding: 1px 5px; border-radius: 8px; opacity: .8; border: 1px solid currentColor; white-space: nowrap; }
.bib-lv-gm { color: var(--red, #b54); } .bib-lv-broker { color: var(--gold, #b8902a); } .bib-lv-classified { color: var(--purple, #8459b8); } .bib-lv-party { color: var(--teal, #2a8f86); }
.bib-main { min-width: 0; }
.bib-plain { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.bib-hits li { padding: 2px 0; }
.bib-section { margin-top: 18px; }
.bib-section h3 { font-size: 1rem; margin: 0 0 6px; }
.bib-cards { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.bib-card { display: inline-flex; gap: 6px; align-items: center; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line, rgba(127,127,127,.3)); background: none; color: inherit; cursor: pointer; font: inherit; }
.bib-red { margin-top: 12px; }
.bib-editor .bib-fields { border: 1px solid var(--line, rgba(127,127,127,.3)); border-radius: 8px; padding: 8px 12px 12px; margin: 8px 0; }
.bib-editor .bib-wide { grid-column: 1 / -1; }
.bib-editor textarea.code { width: 100%; }
.bib-preview { border: 1px dashed var(--line, rgba(127,127,127,.4)); border-radius: 8px; padding: 8px 14px; min-height: 200px; }
.bib-timeline { list-style: none; padding: 0; margin: 0; border-left: 2px solid var(--accent, #b8902a); }
.bib-timeline li { position: relative; padding: 6px 0 6px 18px; }
.bib-timeline li::before { content: ''; position: absolute; left: -6px; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent, #b8902a); }
.bib-when { display: inline-block; min-width: 9em; font-weight: 600; margin-right: 8px; }
.bib-tfield input { flex: 1 1 160px; }
.bib-pick { max-height: 260px; overflow: auto; display: grid; gap: 4px; margin-bottom: 8px; }
.bib-history { display: grid; gap: 12px; }
.bib-history .lib-link-btn.on { font-weight: 700; }
.bib-diff { max-height: 50vh; overflow: auto; font-size: 12px; white-space: pre-wrap; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.08); }
.bib-diff .bib-add, .bib-add { background: rgba(60, 170, 90, .18); }
.bib-diff .bib-del, .bib-del { background: rgba(200, 70, 60, .18); text-decoration: line-through; }
.bib-diff .bib-gap { opacity: .6; font-style: italic; }
`;
