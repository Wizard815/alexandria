// Put a request in the DM assistant's box from anywhere (a template's "Ask the assistant" button): the panel opens and
// the text waits in the box for the DM to check and send. A leaf module, so a page can use it without loading the chat.
export const PREFILL_EVENT = 'alx-agent-prefill';
let pending = '';

/** Open the assistant with this text in its box (not sent). */
export function askAssistant(text: string) {
  pending = text;
  try { window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail: text })); } catch { /* no window */ }
}

/** The text waiting for a chat box that was not on screen when it was asked for (read once). */
export function takePrefill(): string {
  const t = pending;
  pending = '';
  return t;
}
