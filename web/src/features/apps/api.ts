// The glance (librarian/src/features/glance): what the home-screen widget and the "You" card show.
export interface Glance {
  world: { slug: string; name: string };
  role: 'dm' | 'player' | 'guest';
  name: string;
  date: string | null;
  combat: {
    active: boolean; round: number | null; myTurn: boolean; turnName: string | null;
    me: { name: string; hp: number | null; maxHp: number | null; tempHp: number; conditions: string[] } | null;
  };
  mana: { now: number | null; max: number | null } | null;
  session: { live: boolean; title: string | null; since: string | null; recording: boolean; here: number };
  next: { title: string; startsAt: string; endsAt: string; location: string; happening: boolean; rsvp: string | null; going: number } | null;
  quick: { id: string; kind: string; title: string; closesAt: string | null; answered?: boolean; answers?: number; of?: number }[];
  waiting: Record<string, number>;
  at: string;
}
/** Live events that change the glance. */
export const GLANCE_EVENTS = ['combat', 'spells-char', 'quick-event', 'clock', 'presence', 'calendar', 'rsvp', 'settings'];
export interface AppInfo { downloads: string; version: string; release: string }
