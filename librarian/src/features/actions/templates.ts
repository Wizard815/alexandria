// A library of agent macros the GM can copy and edit. Each is one Minerva step:
// a prompt with {{parameters}}, an allowlist of tools, and a mode (do it).
// Prompts never ask her to show players anything that is not party-level.
import type { ArgSpec } from './catalog.ts';

export interface MacroTemplate { id: string; name: string; description: string; params: ArgSpec[]; steps: { action: string; args: Record<string, any>; delayMs: number; continueOnError: boolean }[] }

const P = (name: string, label: string, def = ''): ArgSpec => ({ name, type: 'string', label, default: def, maxLength: 300 });
const step = (prompt: string, tools: string[], mode: 'do' | 'propose' = 'do') => [{ action: 'minerva.run', args: { prompt, mode, tools: tools.join(',') }, delayMs: 0, continueOnError: false }];
const COMBAT = ['set_combat', 'add_combatant', 'set_initiative', 'next_turn', 'make_statblock'];
const SOUND = ['play_music', 'stop_music', 'play_ambience', 'play_sfx'];

export const TEMPLATES: MacroTemplate[] = [
  { id: 'start-combat', name: 'Start combat', description: 'Combat music, tracker on, the party and the monsters in.', params: [P('monsters', 'Monsters (e.g. two goblins and an ogre)')],
    steps: step('Start combat now. Play combat music, turn the combat tracker on (set_combat active true), add every player character (list_members, each with a rolled d20 initiative) and add these monsters: {{monsters}}. Give each monster a rolled initiative; use make_statblock from the rules module when it finds one, otherwise add_combatant with just a name. Do not show anything on the stage.', [...COMBAT, ...SOUND, 'list_members']) },
  { id: 'end-combat-loot', name: 'End combat & loot', description: 'End the fight, calm music, and hand out loot.', params: [P('loot', 'Loot (e.g. 40 gold and a silver key)')],
    steps: step('End the fight: turn the combat tracker off, fade to calm music. Then give the party this loot with add_coin / add_item to the party pouch: {{loot}}. If no loot was given, give nothing.', ['set_combat', ...SOUND, 'add_item', 'add_coin', 'generate_coins', 'generate_items']) },
  { id: 'ambush', name: 'Ambush', description: 'Tense music, a map on the stage, an ambush check, combat with the attackers.', params: [P('place', 'Where'), P('map', 'Map page to show (party-visible)'), P('monsters', 'Attackers')],
    steps: step('Start an ambush at {{place}}: play tense music, show the map {{map}} on the stage if the library has a party-visible page for it (search_library; never show a page players cannot open), ask the table for a DC 13 Perception quick event, start combat with the tracker (set_combat active true) and add the PCs and these attackers: {{monsters}}.', [...COMBAT, ...SOUND, 'show_on_stage', 'send_quick_event', 'list_members', 'search_library']) },
  { id: 'enter-tavern', name: 'Enter tavern', description: 'Calm tavern music and chatter, and the tavern card on the stage.', params: [P('tavern', 'Tavern name or page')],
    steps: step('The party enters {{tavern}}. Play calm music, set the ambience to tavern chatter and a fire, and show the tavern page on the stage if it is a party-visible library page.', [...SOUND, 'show_on_stage', 'search_library', 'read_page']) },
  { id: 'long-rest', name: 'Long rest', description: 'Advance the clock, calm night ambience.', params: [],
    steps: step('The party takes a long rest. Advance the world clock with the long-rest preset, play calm music quietly and put on night ambience (fire, crickets).', ['advance_world_time', ...SOUND, 'get_world_date']) },
  { id: 'travel-montage', name: 'Travel montage', description: 'Time passes, travel music, weather ambience, a travel note.', params: [P('destination', 'Destination'), P('hours', 'Hours of travel', '4')],
    steps: step('The party travels to {{destination}}: advance the world clock by {{hours}} hours, play calm travel music, set ambience that suits an open road (wind, birds), and post one short line to the table chat describing the journey.', ['advance_world_time', ...SOUND, 'send_table_chat']) },
  { id: 'reveal-handout', name: 'Reveal handout', description: 'Show a party-visible page on the stage and play a sting.', params: [P('handout', 'Handout page title')],
    steps: step('Reveal the handout {{handout}}: find it with search_library; show it on the stage (show_on_stage kind place, spotlight true) ONLY if it is a page players can open (a party-level page). If it is not, do nothing and say so. Play a short sound effect if the library has a fitting one.', ['show_on_stage', 'search_library', 'read_page', 'play_sfx']) },
  { id: 'shop-open', name: 'Shop open', description: 'Calm shop music and the shop card on the stage.', params: [P('shop', 'Shop page title')],
    steps: step('Open the shop {{shop}}: play calm music and show the shop page on the stage (show_on_stage kind shop with its library page id) only if players can open that page.', ['show_on_stage', 'search_library', 'read_page', ...SOUND]) },
  { id: 'boss-entrance', name: 'Boss entrance', description: 'Boss music, a sting, the boss joins the tracker.', params: [P('boss', 'Boss name'), P('place', 'Where', 'the chamber')],
    steps: step('{{boss}} makes an entrance in {{place}}: play combat music, play a dramatic sound effect, and add {{boss}} to the combat tracker with a rolled initiative (make_statblock from the rules module if one is found). Start combat if it is not running.', [...COMBAT, ...SOUND, 'search_library']) },
  { id: 'session-start-recap', name: 'Session start recap', description: 'A short recap for the table from what the party already knows.', params: [],
    steps: step('Prepare the session start: read the latest session log (list_session_log) and, from party-level information only, post a three-sentence "previously on" recap to the table chat (send_table_chat), then play calm music. Never include GM-only notes or secrets.', ['list_session_log', 'send_table_chat', 'read_page', ...SOUND]) },
  { id: 'session-end-wrap', name: 'Session end wrap-up', description: 'Stop the sound, draft the session summary and update the status.', params: [P('notes', 'Anything to remember')],
    steps: step('Wrap up the session: stop the music and ambience, draft the session summary (draft_session_summary), and add a status update (status_update) with what changed. Extra notes from the GM: {{notes}}.', ['stop_music', 'play_ambience', 'draft_session_summary', 'status_update', 'memory_log'], 'do') },
];
