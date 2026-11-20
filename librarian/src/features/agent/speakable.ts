// Turn an assistant reply (markdown) into what a person would say aloud, for the text-to-speech model.
// Reading "asterisk asterisk" or a URL letter by letter is worse than skipping it, so formatting goes and
// the words stay. The cap keeps one answer from tying up the voice model for minutes.
export const SPEAK_MAX = 1200;

export function speakable(markdown: string): string {
  let t = String(markdown ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // code blocks are not read
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                 // images
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1'); // wikilinks keep their words
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');               // links keep their text
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ').replace(/\|/g, ', ');   // table rules and cell bars
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length <= SPEAK_MAX) return t;
  // Cut at a sentence end when there is one near the cap, so the voice does not stop mid-word.
  const cut = t.slice(0, SPEAK_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > SPEAK_MAX * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}
