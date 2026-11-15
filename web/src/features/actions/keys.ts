// Key combinations, spelled the way the librarian stores them
// ("Ctrl+Alt+Shift+1", "F13"). Used to capture a key press and to match a
// binding while the tab is focused.
export const captureState = { on: false };

/** The combo for a key event, or null for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad(\d|Add|Subtract|Multiply|Divide|Decimal|Enter)$/.test(e.code)) key = e.code;
  else if (e.key === ' ') key = 'Space';
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) key = e.key;
  else if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null;
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean) as string[];
  return [...mods, key].join('+');
}
