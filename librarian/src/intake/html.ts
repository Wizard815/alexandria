// Small HTML to Markdown converter for sources that store rich text as HTML
// (Kanka, many REST APIs). Scripts, styles and comments are dropped; links to
// Kanka entities become mentions.
export function htmlToMarkdown(html: string): string {
  let s = String(html ?? '').replace(/\r/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '');
  // Kanka mention anchors in entry_parsed: <a class="entity-mention" data-id="<entity id>"
  // href="…/w/<campaign>/entities/<entity id>">, or data-entity-id on older pages.
  s = s.replace(/<a\b[^>]*?(?:data-entity-id="(\d+)"|href="[^"]*\/entities\/(\d+)[^"]*"|class="[^"]*\bentity-mention\b[^"]*"[^>]*?\bdata-id="(\d+)")[^>]*>([\s\S]*?)<\/a>/gi, (_m, a, b, c, label) => `[[@kanka:${a ?? b ?? c}|${strip(label)}]]`);
  s = s.replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `[${strip(t)}](${href})`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${strip(t)}\n\n`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) => '\n\n' + strip(t.replace(/<\/p>/gi, '\n')).split('\n').map((l: string) => `> ${l}`).join('\n') + '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/(ul|ol)>/gi, '\n\n');
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');
  s = s.replace(/<\/(p|div|tr)>/gi, '\n\n').replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, '');
  return decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const strip = (s: string) => decode(String(s).replace(/<[^>]+>/g, '')).trim();

function decode(s: string) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}
