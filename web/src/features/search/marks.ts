// Search snippets come from the server as escaped HTML with <mark> around
// matches. This keeps only those marks: any other tag is escaped again, so a
// snippet can never inject markup even if a server bug let one through.
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function safeMarks(html: string | null | undefined): string {
  const parts = String(html ?? '').split(/(<\/?mark>)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : p.replace(/</g, '&lt;').replace(/>/g, '&gt;'))).join('');
}

/** Marked HTML if the server sent it, else the plain snippet escaped. */
export const snippetOf = (h: { snippetHtml?: string; snippet?: string }) => (h.snippetHtml !== undefined ? safeMarks(h.snippetHtml) : escapeHtml(h.snippet ?? ''));
