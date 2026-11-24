// What every DM page is called, in one place: the menu, the side-screen and pop-out panel pickers, the Screens page and the
// page headers all read these, so a page has one short name, one icon and one line of description everywhere.
// A leaf module (no imports) so anything can use it without a cycle.

export type DMGroupId = 'run' | 'players' | 'world' | 'prep' | 'setup';

export interface DMName { label: string; icon: string; desc: string; group: DMGroupId }

export const DM_GROUPS: { id: DMGroupId; label: string; icon: string }[] = [
  { id: 'run', label: 'Play', icon: 'fa-dice-d20' },
  { id: 'players', label: 'Players', icon: 'fa-users' },
  { id: 'world', label: 'World', icon: 'fa-globe' },
  { id: 'prep', label: 'Prep', icon: 'fa-hammer' },
  { id: 'setup', label: 'Setup', icon: 'fa-gear' },
];

/** Keyed by the route under /w/:world/dm/ ('' is the table). The key order is the menu order inside a group. */
export const DM_NAMES: Record<string, DMName> = {
  '': { group: 'run', label: 'Table', icon: 'fa-table-cells-large', desc: 'Everything live in the world, at a glance.' },
  combat: { group: 'run', label: 'Combat', icon: 'fa-khanda', desc: 'Initiative, conditions and monster health.' },
  quick: { group: 'run', label: 'Quick events', icon: 'fa-bolt', desc: 'Timed prompts on the players’ screens.' },
  scenes: { group: 'run', label: 'Scenes', icon: 'fa-clapperboard', desc: 'One button sets the TV, sound, lights and map.' },
  stage: { group: 'run', label: 'Stage', icon: 'fa-image', desc: 'Prepare cards, then show them to the table.' },
  'screen-players': { group: 'run', label: 'Players’ TV', icon: 'fa-tv', desc: 'What the TV facing the players shows; queue videos and pictures.' },
  sound: { group: 'run', label: 'Sound', icon: 'fa-music', desc: 'Music, ambience and sound effects.' },
  clock: { group: 'run', label: 'Clock', icon: 'fa-moon', desc: 'The in-world date and time.' },
  active: { group: 'run', label: 'Active mode', icon: 'fa-ear-listen', desc: 'Let the assistant listen and act while a session records.' },

  inbox: { group: 'players', label: 'Inbox', icon: 'fa-inbox', desc: 'Coin and item approvals, and what players ask for.' },
  sharing: { group: 'players', label: 'Sharing & keys', icon: 'fa-share-nodes', desc: 'Share pages with players, invite people, and give out API and AI keys.' },
  party: { group: 'players', label: 'Party', icon: 'fa-sack-dollar', desc: 'Packs and coin for every player.' },
  broker: { group: 'players', label: 'Broker', icon: 'fa-scale-balanced', desc: 'Information players can buy, and your price tiers.' },
  chat: { group: 'players', label: 'Table chat', icon: 'fa-comments', desc: 'Live chat for the whole table or just the party.' },
  messages: { group: 'players', label: 'Messages', icon: 'fa-envelope', desc: 'Private chats between people in this world.' },
  calendar: { group: 'players', label: 'Game nights', icon: 'fa-calendar-days', desc: 'Real-life sessions: RSVPs and rescheduling.' },

  library: { group: 'world', label: 'Library', icon: 'fa-book', desc: 'Every page in the world, searchable.' },
  people: { group: 'world', label: 'People', icon: 'fa-user-group', desc: 'Everyone the party has met.' },
  relations: { group: 'world', label: 'Relations', icon: 'fa-diagram-project', desc: 'Who is related to, or a member of, whom.' },
  map: { group: 'world', label: 'Map', icon: 'fa-map', desc: 'Pins and notes on the map; hide or erase any.' },
  rules: { group: 'world', label: 'Rules', icon: 'fa-scroll', desc: 'Spells, conditions and monsters from the game module.' },
  whiteboard: { group: 'world', label: 'Whiteboard', icon: 'fa-chalkboard', desc: 'One shared board that stays between sessions.' },

  sculpt: { group: 'prep', label: 'Sculpting', icon: 'fa-wand-magic-sparkles', desc: 'Fill a few blanks; the rest is made to fit your world.' },
  generators: { group: 'prep', label: 'Generators', icon: 'fa-dice', desc: 'NPCs, monsters, maps, taverns and names.' },
  bible: { group: 'prep', label: 'Story bible', icon: 'fa-book-open', desc: 'What the library says about the world, as facts.' },
  minerva: { group: 'prep', label: 'Minerva', icon: 'fa-brain', desc: 'The campaign’s memory: status, arc, who knows what.' },
  worldlore: { group: 'prep', label: 'WorldLore', icon: 'fa-feather-pointed', desc: 'The AI’s own wiki for this world.' },
  sessionlog: { group: 'prep', label: 'Recaps', icon: 'fa-clock-rotate-left', desc: 'What happened, session by session; draft and publish summaries.' },
  recordings: { group: 'prep', label: 'Recordings', icon: 'fa-record-vinyl', desc: 'Play, download and clear each session’s audio and transcript.' },
  macros: { group: 'prep', label: 'Macros', icon: 'fa-bolt-lightning', desc: 'Named sequences of actions, run from a button or key.' },
  lights: { group: 'prep', label: 'Lights', icon: 'fa-lightbulb', desc: 'Lights on your network that follow the game.' },

  screens: { group: 'setup', label: 'Screens', icon: 'fa-display', desc: 'Open the side, TV and table screens on your monitors.' },
  audio: { group: 'setup', label: 'Microphones', icon: 'fa-microphone', desc: 'Choose the mics the table transcript listens to.' },
  phone: { group: 'setup', label: 'Phone', icon: 'fa-mobile-screen', desc: 'Your pocket remote and assistant.' },
  settings: { group: 'setup', label: 'Settings', icon: 'fa-gear', desc: 'Visibility, invites and options for this world.' },
  connect: { group: 'setup', label: 'Connect AI', icon: 'fa-plug', desc: 'Make a key to link an AI app to this world.' },
};

/** The page's name, for a page header or a picker: the same words as the menu. */
export const dmLabel = (route: string): string => DM_NAMES[route]?.label ?? route;
