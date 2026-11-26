// Cheap, deterministic reading of what the user typed, so most messages need
// no extra model round: which tools to offer (at most MAX_TOOLS), what to
// search the library for, and the commands that are answered by a rule with
// no model at all (rolling dice, the date, next turn, adding creatures).
import { randomInt } from 'node:crypto';

export const MAX_TOOLS = 16;
/** Offered to the player harness for every message. */
export const CORE_TOOLS = ['search_library', 'read_page'];
/** Offered to the DM harness for every message: the tools of a DM's working day. `more_tools` is the harness's own meta tool. */
export const DM_CORE_TOOLS = ['search_library', 'read_page', 'save_page', 'context_for', 'who_is', 'memory_log', 'status_update', 'get_combat', 'lookup_rule', 'more_tools'];

interface Category { re: RegExp; tools: string[] }

// Most specific first: when the cap is reached, the categories at the end are the ones left out.
// A message may match several. Each list is in order of usefulness.
const CATEGORIES: Category[] = [
  { re: /\b(make|write|build|create|draft|design|add|change|edit|fix|copy|import)\b.{0,40}\b(house ?rules?|mods?|rule files?|homebrew (rule|system)s?|variant rules?|table rules?)\b|\b(house ?rule|mod) (file|studio|kit)\b/i, tools: ['house_rule_guide', 'house_rule_file', 'house_rule_check', 'house_rule_save', 'house_rules'] },
  { re: /\b(house ?rules?|table rules?|variant rules?|re-?rolls?|inspiration|hero points?|luck (tokens?|points?)|reward (the |their |good )?(rp|roleplay|role-play))\b/i, tools: ['house_rule_grant', 'house_rules', 'house_rule_counters', 'house_rule_spend', 'house_rule_check', 'house_rule_save'] },
  // DownTime (the feature) and a house rule's own data system can both answer "downtime": a plain mention offers the core of each.
  { re: /\b(down ?time|downtime activit\w*|between (adventures|sessions))\b/i, tools: ['downtime', 'downtime_round', 'downtime_time', 'house_rule_prompt', 'house_rule_records', 'house_rule_record_act'] },
  { re: /\b(lost (\w+ )?days?|(days?|weeks?|months?) (of|off) (rest|work|crafting|training|research)|carous\w*|work(ing)? a job|stronghold|legendary (task|vigil)|group (task|activit\w*)|(reward|finish(ed)?|stop|remove|close|assign|log|spent \w+ days?)\b.{0,40}\b(down ?time|task|crafting|research|training|round))\b/i, tools: ['downtime_time', 'downtime_work', 'downtime_assign', 'downtime_reward', 'downtime_update', 'downtime_remove', 'downtime_close_round', 'downtime_log'] },
  { re: /\b(suggest|recommend|what (can|should) i do|pick (my|for)|my downtime|join (the|a) (group|party)|(start|begin) (an? )?(activit\w*|task|project))\b/i, tools: ['downtime_activities', 'downtime_suggest', 'downtime_pick', 'downtime_start', 'downtime_log'] },
  { re: /\b(random event|quick[- ]?time|what happened (in|during) (my |their |the )?down ?time|roll (for |my |the )?(event|check)|rats? in the cellar)\b/i, tools: ['downtime_events', 'downtime_event_roll', 'downtime_event_decide'] },
  { re: /\b(down ?time|activit(y|ies)|tasks?|projects?|crafting queue|reputation|a (downtime )?day passes|house rule (list|records?))\b/i, tools: ['house_rules', 'house_rule_records', 'house_rule_record_act', 'house_rule_prompt', 'house_rule_my_record'] },
  { re: /\bfoundry\b|\bvtt\b|\b(move|drag|put) (the |my |our )?[\w' -]{0,30}token\b|\btokens?\b.*\b(scene|map)\b/i, tools: ['foundry_status', 'foundry_move_token', 'foundry_send_map', 'foundry_send_handout', 'foundry_say', 'list_pages'] },
  { re: /\broll ?20\b/i, tools: ['roll20_status', 'roll20_send_handout', 'roll20_say', 'list_pages'] },
  { re: /\bowlbear\b|\bvtt\b|\bvirtual table(top)?\b/i, tools: ['owlbear_status', 'owlbear_link'] },
  { re: /\b(share|unshare)\b|\bshared with\b|\bwho can (see|read|open)\b|\bnew from the dm\b|\bsend (this|that|the|a|my) (\w+ )?(page|file|folder|handout|picture|image) (to|with)\b/i, tools: ['share_library_item', 'library_sharing', 'list_pages', 'read_page'] },
  { re: /\b(open|close|start|end|begin|finish)\b.*\b(the table|a game session|tonight'?s game|game session)\b|\bgame session (open|closed)\b/i, tools: ['start_game_session', 'end_game_session', 'get_game_session'] },
  { re: /\b(accept|reject|decline|approve)\b.*\bdate (change|the draft)|\bdate change\b/i, tools: ['decide_session_date', 'list_session_log_drafts', 'read_session_log_draft'] },
  { re: /\b(own (codex )?page|keeps? coming up|promote (him|her|them|it)|give (him|her|them) (a |his |her |their )?(own )?(codex )?page)\b/i, tools: ['promote', 'who_is', 'codex_upsert', 'context_for'] },
  { re: /\blink\b.*\b(to|with)\b.*\b(page|item)\b|\b(item|dagger|sword|ring)\b.*\bown (library )?page\b/i, tools: ['link_item_page', 'get_inventory', 'get_item_card'] },
  { re: /\b(goals?|heat|ongoing|simmering)\b.*\b(goal|heat|ongoing|simmering|bump|raise|mark|update|cool)|\b(bump|raise|cool|mark)\b.*\bgoal\b/i, tools: ['goal_update', 'context_for', 'who_is'] },
  { re: /\b(youtube|video|slideshow|slide show|(players'?|table) (tv|screen|display)|(on|to) the (tv|big screen))\b/i, tools: ['queue_media', 'show_media', 'show_on_stage'] },
  { re: /\b(show|put|bring up|display|throw)\b.*\b(whole table|to everyone|for everyone|(to|for) the (players|table|party)|on the (stage|screen))\b|\b(cards?|what('s| is)) (is )?on the (table )?(screen|stage|board)\b|\b(table|stage) screen\b/i, tools: ['show_on_stage', 'get_stage', 'hide_stage_card'] },
  { re: /\b(tell|message|post to|say to|announce to|let)\b.*\b(the table|the players|everyone|the party)\b.*\b(chat|know|that)\b|\bover (the )?(table )?chat\b/i, tools: ['send_table_chat', 'read_table_chat'] },
  { re: /\b(recap|summary)\b.*\b(draft|session)\b|\bdraft\b.*\b(recap|summary)\b/i, tools: ['draft_session_summary', 'list_session_log_drafts', 'list_session_log'] },
  { re: /\b(quickly note|note this (idea|down)|jot this|an idea\b|idea:)/i, tools: ['memory_capture', 'memory_log'] },
  { re: /\b(close in theme|similar (in theme )?to|like the .* page|read like|same vibe)\b/i, tools: ['related_pages', 'search_world', 'read_page'] },
  { re: /\b(magic items?|a few items|some items|items? (suitable|for) (a )?level|loot (table|roll))\b/i, tools: ['generate_items', 'generate_coins', 'add_item'] },
  { re: /\b(next (real[- ]life )?(game|session)|game session scheduled|session scheduled|when (is|are) (we|the next))\b/i, tools: ['list_calendar', 'schedule_session'] },
  { re: /\b(trad(e|ed|es|ing)|swapp?(ed)?|exchang(e|ed))\b/i, tools: ['list_transfers', 'list_my_trades', 'get_inventory'] },
  { re: /\b(all (our|the) players|players and (the )?characters|who plays|characters (they|the players) play|list (the )?(players|members))\b/i, tools: ['list_members', 'get_live'] },
  { re: /\b(sign[- ]?off|pending|waiting (for|on) (me|my)|needs? my (ok|ok|approval|attention))\b/i, tools: ['list_approvals', 'list_requests', 'list_broker_requests'] },
  { re: /\b(release|deliver|hand over|let (it|that|the answer) (through|out|go)|waiting for (my )?review|needs my review|refuse|decline)\b.*\b(broker|answer|question)|\bbroker (answer|question)s?\b.*\b(release|deliver|review|refuse|decline)/i, tools: ['broker_deliver', 'broker_refuse', 'list_broker_requests', 'broker_answer'] },
  { re: /\b(ally|rival|neutral|attitude|let the (whole )?party (see|know)|make \w+( \w+)? (an? )?(ally|rival)|has been met|mark .* as met)\b/i, tools: ['update_person', 'list_people', 'add_person'] },
  { re: /\b(journal draft|draft (my|a) journal|write up (my|the) (session|journal)|(summari[sz]e|write) (the|my) (session|night) for my (journal|notes))\b/i, tools: ['my_journal_draft', 'my_memory_log', 'my_context'] },
  { re: /\b(catch me up|previously|what happened (last|in the last|so far)|recap (of )?(the )?(last|previous))\b/i, tools: ['my_recap', 'list_session_log', 'search_transcript'] },
  { re: /\b(activate|run|trigger|switch to|go to|start|cue) (the |a |my )?([\w' -]{1,30} )?(scene|preset)\b|\b(saved|my) scenes?\b|\bset the (whole )?room\b|\bone[- ]button\b/i, tools: ['activate_scene', 'list_scenes'] },
  { re: /\b(play|mood|tense|ambience|ambient|sound|sounds|music|scene|layer|soundtrack|sound ?board|sound effects?|sfx|thunder|rain|creak|hush|eerie|spooky|creepy|ominous|haunting|battle music)\b/i, tools: ['get_sound_now', 'play_music', 'play_ambience', 'send_scene', 'play_sfx', 'stop_music', 'list_sound_library', 'list_sound_scenes'] },
  { re: /\b(templates?|sculpt\w*)\b/i, tools: ['list_templates', 'sculpt_templates', 'sculpt', 'create_template'] },
  { re: /\b(guides?|dm templates?|templates? (?:and|&) guides?|web research|research (?:the|a|an|it|on)|search the web|look (?:it |that )?up online|on the (?:web|internet)|irl|real[- ]world)\b/i, tools: ['list_dm_templates', 'get_dm_template', 'create_dm_template', 'update_dm_template', 'web_research'] },
  { re: /\b(initiative|end (the )?(fight|combat|battle|encounter)|flee|fled|flees|run away|remove|removed|kill(ed)?|dead|dies|died|defeated|slain)\b/i, tools: ['set_initiative', 'remove_combatant', 'set_combat', 'damage_combatant', 'add_combatant', 'next_turn'] },
  { re: /\b(concentrat\w*|temp(orary)? (hp|hit points)|death sav\w*|saving throws? (at|on) 0|stabili[sz]e\w*|unconscious|dying|nat(ural)? (20|1)|crit(ical)?)\b/i, tools: ['give_temp_hp', 'set_concentration', 'concentration_save', 'death_save', 'set_combatant_state', 'damage_combatant', 'heal_combatant', 'get_combat'] },
  { re: /\b(party (status|health|hp|mana)|(player|character|their|his|her)'?s? (hp|health|hit points|mana|sheet)|how (hurt|healthy) is|sheets?|re-?rolls?|inspiration)\b/i, tools: ['party_status', 'change_player_hp', 'give_reroll'] },
  { re: /\b(open5e|dnd5e ?api|5e (srd )?api|srd|tome of (beasts|heroes)|creature codex|deep magic|vault of magic|black flag|a5e|(import|pull)( in)? (more |new )?(spells|monsters|creatures|magic items|items|books?|content|feats|backgrounds|species)|(more|new) (monsters|spells|magic items) from|third[- ]party (books?|content|monsters|spells))\b/i, tools: ['list_content_books', 'import_content', 'lookup_term'] },
  { re: /\b(stat ?blocks?|stats? for|cr \d|challenge rating)\b/i, tools: ['make_statblock', 'lookup_term', 'read_term', 'add_combatant'] },
  { re: /\b(combat|turn|round|fight|battle|damage|damaged|hit|hits|heal|heals|healed|hp|hit points|condition|prone|poisoned|stunned|grappled|frightened|encounter|attack|add \d|goblins?|orcs?|ogres?|kobolds?|skeletons?|zombies?|wolf|wolves|bandits?|cultists?|takes \d+)\b/i, tools: ['add_combatant', 'damage_combatant', 'heal_combatant', 'next_turn', 'set_initiative', 'set_conditions', 'remove_combatant', 'set_combat'] },
  { re: /\b(start a mystery|new mystery|a mystery:|create a mystery)\b/i, tools: ['revelation_create', 'revelation_mark', 'context_for'] },
  { re: /\b(add (an? )?(npc|person)|npc called|new person)\b/i, tools: ['add_person', 'update_person', 'add_quote', 'list_people'] },
  { re: /\b(record that .* said|said ["“]|quotes?)\b/i, tools: ['add_quote', 'list_people', 'add_person'] },
  { re: /\b(tried to recall|recall(ed)? what|add a recall)\b/i, tools: ['add_recall', 'list_people', 'update_person'] },
  { re: /\b(voice presets?|presets?)\b/i, tools: ['list_voice_presets', 'speak'] },
  { re: /\b(which world|world settings|settings do we have|switched on)\b/i, tools: ['world_info', 'world_sources'] },
  { re: /\b(refresh (the )?world|resync|re-?sync|sync (everything|all|the sources)|update (the )?(index|knowledge)|rebuild (the )?(index|knowledge))\b/i, tools: ['refresh_world', 'world_sources'] },
  { re: /\b(quick events?|recall check|vote|poll|reaction|twist|saving throw for the party)\b/i, tools: ['list_quick_events', 'send_quick_event', 'resolve_quick_event', 'cancel_quick_event'] },
  { re: /\b(encounters?|npc (walks|comes) up|walks up to|approaches|wander(ing)?|street gambler|shell game|coin toss|dice duel|peddler|mini-?games?)\b/i, tools: ['list_encounters', 'list_encounter_templates', 'send_encounter', 'encounter_say', 'end_encounter'] },
  { re: /\b(arcs?|close the (current )?arc|new arc|start an arc)\b/i, tools: ['arc_close', 'arc_start', 'context_for', 'codex_upsert'] },
  { re: /\b(jot|jot down|note down|write (this |that |it )?down|an idea|idea:|log that|log this|file (this )?conversation|by speaker)\b/i, tools: ['memory_capture', 'conversation_log', 'memory_log'] },
  { re: /\b(broker|special offers?|offers?|information for sale|sell (this|that|the) (fact|info)|may sell)\b/i, tools: ['add_broker_note', 'send_broker_offer', 'list_broker_requests', 'broker_answer', 'list_broker_offers', 'ask_broker_quote', 'broker_pay_options', 'broker_deliver', 'broker_refuse'] },
  { re: /\b(item cards?|link .* (to )?(a )?page|magic items?)\b/i, tools: ['get_item_card', 'link_item_page'] },
  { re: /\b(related pages?|similar pages?|read like|other pages|everything we have|search everything)\b/i, tools: ['related_pages', 'search_world', 'story_bible'] },
  { re: /\b(relations?|relationships?|family links?|links between|connections between)\b/i, tools: ['list_relations', 'list_people'] },
  { re: /\b(who is (online|here|present)|online right now|presence|who('s| is) at the table)\b/i, tools: ['get_live', 'list_members'] },
  { re: /\b(rumou?rs? table|rumou?rs? the sailors|as a rumou?r|travel events?|boxed text|prep checklist)\b/i, tools: ['sculpt', 'list_templates', 'sculpt_templates', 'send_scene'] },
  { re: /\b(save (that|it|this|the) (generated |tavern |npc |map |monster )?(to|as|in)|save_generated)\b/i, tools: ['save_generated', 'generate', 'generate_map', 'save_page'] },
  { re: /\b(shops?|shopkeepers?|store|stores|merchants?|blacksmiths?|weaponsmiths?|armou?rers?|enchanters?|alchemists?|smithy|fence|curios?|trinkets?|for sale|restock|item database|items? db|wares|haggle|haggling|barter|discount|price level|inflat\w*)\b/i, tools: ['generate_shop', 'list_shops', 'read_shop', 'search_items', 'stock_shop', 'set_shop_status', 'create_shopkeeper', 'create_item', 'edit_item', 'present_shop', 'shop_memory', 'give_shop_deal', 'list_towns', 'set_town'] },
  { re: /\b(towns?|market|reputation|standing)\b/i, tools: ['list_towns', 'set_town', 'shop_memory'] },
  { re: /\b(transfers?|who (gave|has given)|has given|given what|trades?)\b/i, tools: ['list_transfers', 'list_my_trades', 'get_inventory'] },
  { re: /\b(answer .*question|(player|players|anselm|jess\w*|tomas?)['’]?s? questions?|requests?|approvals?|approve)\b/i, tools: ['list_requests', 'decide_request', 'list_approvals', 'decide_approval'] },
  { re: /\b(promote|arcs?|goals?|mystery|mysteries|revelations?|capture|transcript|clues?|campaign status|status doc|hooks?|threads?|accrete|codex|memory)\b/i, tools: ['codex_upsert', 'revelation_mark', 'goal_update', 'promote', 'search_transcript', 'memory_capture', 'revelation_create', 'arc_close', 'arc_start', 'conversation_log'] },
  { re: /\b(names?|name for|naming)\b/i, tools: ['generate_names'] },
  { re: /\b(coins?|gold|loot|hoard|treasure|copper|silver|platinum)\b/i, tools: ['generate_coins', 'add_coin', 'generate_items'] },
  { re: /\b(inventory|stash|items?|give|gave|given|pouch|purse)\b/i, tools: ['get_inventory', 'add_item', 'add_coin', 'move_item', 'list_transfers', 'generate_items', 'list_my_trades'] },
  { re: /\b(npc|npcs|villain|monster|boss|creature|dungeon|cave|castle|keep|battle ?map|town map|city map|world map|region map|forest map|wilderness|floor ?plan|map of|homebrew|generat(e|or|ors)|random(ly)?|roll up)\b/i, tools: ['generate', 'generate_map', 'save_generated', 'make_statblock'] },
  { re: /\b(spell ?(list|recipes?|crafting|codex)|recipes?|craft(ing)?|combine|mana|spell points?|learn(able)?|tiers?)\b|\bspells?\b.*\b(level|school|cantrips?|ritual|concentration|damage|save)\b/i, tools: ['list_spells', 'read_spell', 'list_spell_recipes', 'draft_spell_recipe', 'my_spell_codex'] },
  { re: /\b(rules?|spell|spells|how (does|do|many|much)|dc \d|advantage|disadvantage|grapple|opportunity attack|saving throw|cast|concentration|cover|rest rules?|feat|class feature)\b/i, tools: ['lookup_rule', 'lookup_term', 'read_term'] },
  { re: /\b(session (log|summary|recap)|summary of the (last )?session|draft (a |the )?(summary|title)|the draft|published|publish|the log|date change)\b/i, tools: ['list_session_log', 'publish_session_log', 'draft_session_summary', 'list_session_log_drafts', 'read_session_log_draft', 'edit_session_log_draft', 'decide_session_date', 'publish_session_log'] },
  { re: /\b(session|last (time|session|game)|recap|happened|said|told|heard|remember|earlier|yesterday|we (met|found|fought|saw|decided))\b/i, tools: ['search_transcript', 'list_session_log'] },
  { re: /\b(world ?lore|llm wiki|your (own )?wiki|workspace)\b/i, tools: ['lore_write', 'lore_list', 'lore_read', 'lore_move', 'lore_delete'] },
  { re: /\b(my (goals?|journal|notes?|knowledge|clues?|bonds?)|write (this |that )?down|jot|remember (this|that)|what do i know|what have i (learned|found))\b/i, tools: ['my_context', 'my_goal_update', 'my_memory_log', 'my_memory_capture', 'my_who_is'] },
  { re: /\b(who is|who was)\b/i, tools: ['who_is', 'context_for', 'story_bible'] },
  { re: /\b(pages?|save|write|draft|create|make a note|note|lore|wiki|library|folder|rewrite|edit|update|summari[sz]e|summary|outline)\b/i, tools: ['save_page', 'list_pages', 'list_relations'] },
  { re: /\b(people|person|quote|quotes|talk(ed)? to|met)\b/i, tools: ['list_people', 'add_person', 'add_quote', 'update_person', 'add_recall'] },
  { re: /\b(requests?|approve|approvals?|change request|reject)\b/i, tools: ['list_approvals', 'decide_approval', 'list_requests', 'decide_request'] },
  { re: /\b(date|time|day|days|week|month|calendar|clock|long rest|short rest|rest|dawn|dusk|midnight|holiday|festival|deadline|someday|no date)\b/i, tools: ['get_world_date', 'advance_world_time', 'list_world_events', 'add_world_event', 'list_someday_events', 'add_someday_event', 'remove_someday_event'] },
  { re: /\b(broker|offer|offers|information for sale|rumou?rs?)\b/i, tools: ['list_broker_requests', 'list_broker_offers', 'ask_broker_quote', 'send_broker_offer', 'add_broker_note', 'broker_answer', 'broker_deliver', 'broker_refuse'] },
  { re: /\b(game night|schedule|rsvp|next game|real[- ]life)\b/i, tools: ['list_calendar', 'schedule_session'] },
  { re: /\b(stage|spotlight|handout|show (it |this |that |the )?(to |on )?(the )?(table|players|screen|party)|put (it |this |that )?on (the )?(stage|screen|board))\b/i, tools: ['show_on_stage', 'get_stage', 'hide_stage_card', 'sculpt', 'speak'] },
  { re: /\b(set the scene|describe (the|a) (scene|room|place|tavern|shop)|read[- ]aloud|boxed text|rumou?rs? table|travel event|riddle|monologue|prep checklist|loot hoard|handout)\b/i, tools: ['sculpt', 'send_scene', 'sculpt_templates', 'list_templates', 'speak', 'show_on_stage', 'send_table_chat'] },
  { re: /\b(speak|say (it )?aloud|voice|narrat\w*|read aloud|aloud)\b/i, tools: ['speak', 'list_voice_presets'] },
  { re: /\b(chat|tell the (table|players|party)|message the (table|players|party)|announce|post to)\b/i, tools: ['send_table_chat', 'read_table_chat', 'read_party_chat', 'get_game_session'] },
  { re: /\b(record(ing)?|start (the |a )?(session|game|game night)|end (the |a )?(session|game|game night)|open the table|close the table|game session)\b/i, tools: ['start_recording', 'stop_recording', 'recording_status', 'start_game_session', 'end_game_session', 'get_game_session'] },
  { re: /\b(macros?|hotkeys?|shortcuts?|trigger)\b/i, tools: ['list_macros', 'run_macro'] },
  { re: /\b(map|pins?|marks?|markers?|route|waypoints?)\b/i, tools: ['list_map_marks', 'add_map_mark', 'hide_map_mark', 'delete_map_mark'] },
  { re: /\b(item cards?|link .* (to )?(a )?page|magic items?)\b/i, tools: ['get_item_card', 'link_item_page'] },
  { re: /\b(sources?|connections?|connected|sync(ed|s)?|imported|where (does|did) .*(library|lore|pages?) come from)\b/i, tools: ['world_sources'] },
  { re: /\b(story bible|bible|what do we know|what is|tell me about|history of|related|similar)\b/i, tools: ['story_bible', 'related_pages', 'search_world'] },
  { re: /\b(find|search|look up|where)\b/i, tools: ['search_world', 'world_info', 'source_lookup'] },
  { re: /\b(kanka|legendkeeper|my key|source lookup|live (lookup|search)|in the source|my (own )?(character|backstory|sheet))\b/i, tools: ['source_lookup'] },
  { re: /\b(who is in|players|party members|character|characters|members)\b/i, tools: ['list_members', 'get_live'] },
];
const DEFAULTS = ['search_transcript', 'list_pages', 'lookup_rule', 'get_world_date', 'list_people', 'get_live'];

/** Every tool name some message can get offered (the categories, the defaults and the always-on ones). */
export const offerableTools = (): Set<string> => new Set([...CORE_TOOLS, ...DM_CORE_TOOLS, ...DEFAULTS, ...CATEGORIES.flatMap((c) => c.tools)]);

/**
 * At most `max` tool names for this message, from the ones a harness may use
 * (`available`). The DM gets a fixed core (DM_CORE_TOOLS) then the matching
 * categories, most specific first, and never the player-only `my_*` tools; a
 * player gets search_library and read_page then the categories. A tool that is
 * not offered but exists is still run if the model asks for it, and
 * `more_tools` lets the model fetch the schemas of others.
 */
export function selectTools(text: string, available: string[], max = MAX_TOOLS, dm = available.includes('save_page')): string[] {
  const have = new Set(available);
  if (dm) have.add('more_tools');
  const out: string[] = [];
  const add = (n: string) => { if (have.has(n) && !out.includes(n) && !(dm && n.startsWith('my_'))) out.push(n); };
  for (const n of dm ? DM_CORE_TOOLS : CORE_TOOLS) add(n);
  let matched = false;
  for (const c of CATEGORIES) if (c.re.test(text)) { matched = true; for (const n of c.tools) add(n); }
  // Combat words are common in plain questions ("what turn is it"): the combat list leaves room for the others.
  if (!matched || (!dm && out.length < max)) for (const n of DEFAULTS) add(n);
  // The core always stays; what does not fit among the categories is left out.
  return out.slice(0, max);
}

const STOP = new Set(('a an the and or of to in on at for with from by about is are was were be been am do does did can could would should will what whats who whom whose which when where why how that this these those there their them they it its you your yours we our us i me my mine he she his her him not no yes please tell show give find any some all more most much many also just like need want know really very into out up down over than then so if as but have has had get got say said says make made tell told ask asked remind explain describe list summari[sz]e').split(/\s+/));

/** The words worth searching the library for, longest first (more specific words rank better). */
export function searchTerms(text: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // Keep the order they were typed in, but only the most specific few.
  const keep = new Set([...out].sort((a, b) => b.length - a.length).slice(0, max));
  return out.filter((w) => keep.has(w));
}

// ---- commands with no model ------------------------------------------------

export interface Roll { notation: string; parts: { sign: 1 | -1; count: number; sides: number; rolls: number[] }[]; modifier: number; total: number; text: string }

/** Roll dice like 2d6+3 or d20-1 or 1d8+1d4+2. Returns null if it is not dice notation or is absurd. */
export function rollDice(notation: string, rng: (n: number) => number = (n) => randomInt(1, n + 1)): Roll | null {
  const src = notation.replace(/\s+/g, '').toLowerCase();
  const tokens = src.match(/[+-]?[^+-]+/g);
  if (!tokens || tokens.join('') !== src) return null;
  const parts: Roll['parts'] = [];
  let modifier = 0;
  let dice = 0;
  for (const tok of tokens) {
    const sign: 1 | -1 = tok.startsWith('-') ? -1 : 1;
    const body = tok.replace(/^[+-]/, '');
    let m: RegExpMatchArray | null;
    if ((m = body.match(/^(\d*)d(\d+)$/))) {
      const count = m[1] === '' ? 1 : Number(m[1]);
      const sides = Number(m[2]);
      if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
      dice += count;
      if (dice > 200) return null;
      parts.push({ sign, count, sides, rolls: Array.from({ length: count }, () => rng(sides)) });
    } else if (/^\d{1,6}$/.test(body)) modifier += sign * Number(body);
    else return null;
  }
  if (!parts.length) return null;
  const total = parts.reduce((s, p) => s + p.sign * p.rolls.reduce((a, b) => a + b, 0), 0) + modifier;
  const shown = parts.map((p, i) => `${i ? (p.sign < 0 ? '- ' : '+ ') : p.sign < 0 ? '-' : ''}${p.rolls.length > 1 ? `(${p.rolls.join(' + ')})` : p.rolls[0]}`).join(' ');
  const mod = modifier ? ` ${modifier < 0 ? '-' : '+'} ${Math.abs(modifier)}` : '';
  return { notation: src, parts, modifier, total, text: `**${src}**: ${shown}${mod} = **${total}**` };
}

export type FastPlan =
  | { kind: 'reply'; text: string; what: string }
  | { kind: 'date'; what: string }
  | { kind: 'calls'; calls: { tool: string; args: Record<string, unknown> }[]; intro: string; what: string }
  | { kind: 'combat'; verb: 'damage' | 'heal' | 'who' | 'init'; target?: string; amount?: number; what: string }
  | { kind: 'pc'; name: string; initiative?: number; what: string };

const clean = (s: string) => s.trim().replace(/^(hey|ok|okay|so)[,\s]+/i, '').replace(/^(please|pls|can you|could you|would you)\s+/i, '').replace(/\s*(please|pls|thanks|thank you)?[.!?]*\s*$/i, '').trim();

const NOT_CREATURE = /\b(page|note|notes|item|items|person|people|npc|quote|coin|coins|gold|silver|copper|session|event|offer|request|to the (library|party|inventory)|about|for the|that|which|who)\b/i;
const singular = (w: string) => (/ies$/i.test(w) ? w.replace(/ies$/i, 'y') : /(ses|xes|ches|shes)$/i.test(w) ? w.replace(/es$/i, '') : /[^s]s$/i.test(w) ? w.replace(/s$/i, '') : w);
const title = (w: string) => w.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * A command that needs no model: rolling dice, the date, next turn, adding
 * creatures, "who's up", damage and healing by name. Null if it is something
 * else (and the model should answer). Writes are only planned here: the agent
 * still asks the DM to confirm them. `dm` is false for a player, who only
 * gets dice and the date.
 */
export function fastPlan(raw: string, dm: boolean, rng: (n: number) => number = (n) => randomInt(1, n + 1)): FastPlan | null {
  if (raw.length > 120) return null;
  const t = clean(raw);
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(?:roll|r|throw)\s+(?:me\s+)?(?:a\s+|an\s+)?(.+)$/i))) {
    let spec = m[1].replace(/^(dice|the dice)\s+/i, '');
    const adv = /\b(with )?(advantage|adv)\b/i.test(spec) ? 'adv' : /\b(with )?(disadvantage|dis)\b/i.test(spec) ? 'dis' : '';
    spec = spec.replace(/\b(with )?(advantage|adv|disadvantage|dis)\b/gi, '').trim();
    if (adv) {
      const base = spec.match(/^d20\s*([+-]\s*\d+)?$/i);
      if (!base) return null;
      const a = rng(20), b = rng(20);
      const mod = base[1] ? Number(base[1].replace(/\s+/g, '')) : 0;
      const pick = adv === 'adv' ? Math.max(a, b) : Math.min(a, b);
      return { kind: 'reply', what: 'roll', text: `**d20 with ${adv === 'adv' ? 'advantage' : 'disadvantage'}**: ${a}, ${b} → ${pick}${mod ? ` ${mod < 0 ? '-' : '+'} ${Math.abs(mod)}` : ''} = **${pick + mod}**` };
    }
    const r = rollDice(spec, rng);
    return r ? { kind: 'reply', what: 'roll', text: r.text } : null;
  }
  // A bare "2d6+3" is a roll too.
  if (/^\d*d\d+(\s*[+-]\s*(\d*d\d+|\d+))*$/i.test(t)) { const r = rollDice(t, rng); return r ? { kind: 'reply', what: 'roll', text: r.text } : null; }

  if (/^(what('?s| is| was)?|tell me|show me|whats)\s+(the\s+)?(current\s+|today'?s\s+)?(in[- ]game\s+|world\s+|game\s+)?(date|time|day)(\s+(today|now|is it|is it now))?$/i.test(t) || /^what\s+(day|date|time)\s+is\s+it(\s+now)?$/i.test(t)) return { kind: 'date', what: 'date' };

  if (!dm) return null;

  if (/^(next(\s+turn)?|end(\s+the)?\s+turn|next up|advance(\s+the)?\s+(turn|initiative)|go to the next (turn|creature|combatant))$/i.test(t)) return { kind: 'calls', what: 'next_turn', intro: 'Moving to the next turn.', calls: [{ tool: 'next_turn', args: {} }] };
  if (/^(who'?s|who is|whose)\s+(up|next|turn)(\s+(is it|now|next))?$/i.test(t) || /^whose turn( is it)?$/i.test(t)) return { kind: 'combat', verb: 'who', what: 'whose_turn' };

  if (/^(?:end|stop|finish)\s+(?:the\s+)?(?:combat|fight|battle|encounter)$/i.test(t) || /^(?:the\s+)?(?:combat|fight|battle|encounter)\s+is\s+over$/i.test(t)) return { kind: 'calls', what: 'end_combat', intro: 'Ending the fight.', calls: [{ tool: 'set_combat', args: { active: false } }] };

  if ((m = t.match(/^(?:damage|hit|hurt|deal)\s+(.+?)\s+(?:for|by|with)\s+(\d{1,4})(?:\s*(?:damage|hp|points?))?$/i)) || (m = t.match(/^(.+?)\s+(?:takes?|took)\s+(\d{1,4})(?:\s+(?:points?\s+of\s+)?(?:[a-z]+\s+)?(?:damage|hp))?(?:\s+(?:from|by|with|to)\s+.+|\s*\(.*\))?$/i))) return { kind: 'combat', verb: 'damage', target: m[1], amount: Number(m[2]), what: 'damage' };
  // "set Goblin 2 initiative to 14", "Goblin 2 initiative 14"
  if ((m = t.match(/^(?:set\s+)?(.+?)(?:'s)?\s+initiative\s+(?:to\s+|is\s+|=\s*)?(\d{1,2})$/i)) && !/^add\b/i.test(t)) return { kind: 'combat', verb: 'init', target: m[1], amount: Number(m[2]), what: 'set_initiative' };
  // "add Tom to combat with initiative 17", "Tom rolled 17 for initiative": a player character with the roll the player made.
  if ((m = t.match(/^add\s+(.+?)\s+(?:to\s+(?:the\s+)?(?:combat|initiative|fight|tracker|encounter)\s+)?(?:with|at|on)\s+(?:an?\s+)?(?:initiative|init)\s+(?:of\s+)?(\d{1,2})$/i)) || (m = t.match(/^(.+?)\s+rolled\s+(?:a\s+)?(\d{1,2})\s+(?:for\s+|on\s+)?initiative$/i))) {
    if (!NOT_CREATURE.test(m[1]) && !/^\d/.test(m[1])) return { kind: 'pc', name: m[1].replace(/^the\s+/i, ''), initiative: Number(m[2]), what: 'add_pc' };
  }
  if ((m = t.match(/^heal\s+(.+?)\s+(?:for|by)?\s*(\d{1,4})(?:\s*(?:hp|points?))?$/i))) return { kind: 'combat', verb: 'heal', target: m[1], amount: Number(m[2]), what: 'heal' };

  // "add 1d4 goblins", "add 3 orcs to combat", "add a goblin to initiative"
  if ((m = t.match(/^add\s+(\d*d\d+(?:\s*[+-]\s*\d+)?|\d{1,2}|an?)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}?)(?:\s+to\s+(?:the\s+)?(?:combat|initiative|fight|battle|encounter|tracker))?$/iu))) {
    const toCombat = /\bto\s+(?:the\s+)?(?:combat|initiative|fight|battle|encounter|tracker)$/i.test(t);
    const noun = m[2].trim();
    if (NOT_CREATURE.test(noun)) return null;
    if (/^an?$/i.test(m[1]) && !toCombat) return null;
    let n = 1;
    let rolled = '';
    if (/d/i.test(m[1])) { const r = rollDice(m[1], rng); if (!r || r.total < 1) return null; n = r.total; rolled = ` (rolled ${r.notation}: ${r.parts.flatMap((p) => p.rolls).join(', ')}${r.modifier ? ` ${r.modifier > 0 ? '+' : '-'} ${Math.abs(r.modifier)}` : ''})`; }
    else if (!/^an?$/i.test(m[1])) n = Number(m[1]);
    if (n < 1 || n > 20) return null;
    const base = title(n === 1 ? singular(noun) : singular(noun));
    const calls = Array.from({ length: n }, (_, i) => ({ tool: 'add_combatant', args: { name: n === 1 ? base : `${base} ${i + 1}`, initiative: rng(20) } }));
    return { kind: 'calls', what: 'add_combatants', calls, intro: `Adding ${n} ${base}${n === 1 ? '' : 's'}${rolled}, each with a rolled d20 initiative. I don't know their HP: tell me, or ask me to make a statblock for them.` };
  }
  return null;
}

/** "Goblin 3" -> the combatant it names, if exactly one does. */
export function matchCombatant<T extends { id: string; name: string }>(list: T[], name: string): T | null {
  const n = name.trim().toLowerCase().replace(/^the\s+/, '');
  if (!n) return null;
  const exact = list.filter((c) => c.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(n));
  if (starts.length === 1) return starts[0];
  const has = list.filter((c) => c.name.toLowerCase().includes(n));
  return has.length === 1 ? has[0] : null;
}
