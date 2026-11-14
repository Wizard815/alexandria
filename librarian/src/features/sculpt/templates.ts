// The built-in sculpting templates. Each world gets its own editable copy.
export type FieldType = 'text' | 'longtext' | 'number' | 'select' | 'list' | 'name' | 'item' | 'coins' | 'page' | 'statblock';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'longtext', 'number', 'select', 'list', 'name', 'item', 'coins', 'page', 'statblock'];

export interface Field {
  key: string; label: string; type: FieldType;
  options?: string[]; hint?: string; required?: boolean; dmOnly?: boolean;
  /** Filled without a model: the world clock's date, or a shop's stock. */
  gen?: 'clock' | 'stock';
}
export type Target =
  | { kind: 'page'; path: string; visibility: 'dm' | 'party' }
  | { kind: 'person'; path: string; visibility: 'dm' | 'party'; alsoPage?: boolean }
  | { kind: 'combat'; path?: string }
  | { kind: 'shop'; path: string; visibility: 'dm' | 'party'; listField?: string }
  | { kind: 'none' };

export interface TemplateDef {
  key: string; name: string; description: string; perspective: 'dm' | 'player';
  fields: Field[]; body: string; target: Target;
}

const CRS = ['0', '1/8', '1/4', '1/2', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '15', '17', '20'];

export const BUILTINS: TemplateDef[] = [
  {
    key: 'statblock', name: 'Quick statblock', perspective: 'dm',
    description: 'A full statblock from a name, a type, a CR and a role. Add it straight to combat.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', hint: 'A name for this creature or kind of creature', required: true },
      { key: 'type', label: 'Creature type', type: 'text', hint: 'e.g. undead, beast, humanoid' },
      { key: 'cr', label: 'CR', type: 'select', options: CRS },
      { key: 'role', label: 'Role', type: 'select', options: ['brute', 'skirmisher', 'caster', 'controller', 'artillery', 'lurker', 'soldier', 'leader'] },
      { key: 'theme', label: 'Theme', type: 'text', hint: 'A few words of flavour: swamp, clockwork, cult' },
      { key: 'statblock', label: 'Statblock', type: 'statblock', hint: 'A statblock object for the name, type, CR and role' },
    ],
    body: '{{statblock}}',
    target: { kind: 'combat' },
  },
  {
    key: 'npc', name: 'NPC for quick RP', perspective: 'dm',
    description: 'Someone to play right now: look, voice, wants, what they know, a secret and a hook.',
    fields: [
      { key: 'name', label: 'Name', type: 'name', required: true },
      { key: 'race', label: 'Race', type: 'text' },
      { key: 'role', label: 'Role or occupation', type: 'text' },
      { key: 'look', label: 'Look', type: 'longtext', hint: 'Two sentences a player could see at a glance' },
      { key: 'voice', label: 'Voice and mannerism', type: 'text' },
      { key: 'wants', label: 'What they want', type: 'text' },
      { key: 'knows', label: 'What they know', type: 'longtext', hint: 'Party-safe: things they would happily tell the party' },
      { key: 'secret', label: 'A secret', type: 'longtext', dmOnly: true, hint: 'Something the party must not learn easily' },
      { key: 'hook', label: 'Hook', type: 'text', hint: 'How this person pulls the party into something' },
    ],
    body: '# {{name}}\n*{{race}} · {{role}}*\n\n**Look.** {{look}}\n\n**Voice and mannerism.** {{voice}}\n\n**Wants.** {{wants}}\n\n**Knows.** {{knows}}\n\n**Hook.** {{hook}}\n\n{{#dm}}\n**Secret.** {{secret}}\n{{/dm}}\n',
    target: { kind: 'person', path: 'People/{{name}}', visibility: 'dm', alsoPage: true },
  },
  {
    key: 'shop', name: 'Shop or store', perspective: 'dm',
    description: 'A shop with an owner, a price level and stock with prices. Haggling notes stay DM-only.',
    fields: [
      { key: 'name', label: 'Shop name', type: 'text', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: ['smith', 'alchemist', 'general', 'magic'] },
      { key: 'owner', label: 'Owner', type: 'name' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'price', label: 'Price level', type: 'select', options: ['cheap', 'fair', 'dear'] },
      { key: 'inventory', label: 'Inventory', type: 'list', gen: 'stock', hint: 'One item per line: Item - price' },
      { key: 'haggling', label: 'Haggling notes', type: 'longtext', dmOnly: true, hint: 'How the owner bargains and what moves them' },
    ],
    body: '# {{name}}\n*{{kind}} · run by {{owner}} · {{location}} · prices: {{price}}*\n\n## Inventory\n\n{{inventory}}\n\n{{#dm}}\n**Haggling.** {{haggling}}\n{{/dm}}\n',
    target: { kind: 'shop', path: 'Shops/{{name}}', visibility: 'dm', listField: 'inventory' },
  },
  {
    key: 'scene-dm', name: 'Scene, DM perspective', perspective: 'dm',
    description: 'Full DM notes for a scene, including what is really going on.',
    fields: [
      { key: 'title', label: 'Scene title', type: 'text', required: true },
      { key: 'location', label: 'Location', type: 'page', hint: 'A library page' },
      { key: 'time', label: 'Time', type: 'text', gen: 'clock' },
      { key: 'weather', label: 'Weather', type: 'text' },
      { key: 'mood', label: 'Mood', type: 'text' },
      { key: 'sensory', label: 'What the party sees, hears, smells', type: 'longtext', hint: 'Player-safe description' },
      { key: 'going', label: "What's really going on", type: 'longtext', dmOnly: true },
      { key: 'beats', label: 'Beats to play', type: 'list', hint: 'Three or four short bullets' },
    ],
    body: '# {{title}}\n*{{location}} · {{time}} · {{weather}} · {{mood}}*\n\n{{sensory}}\n\n## Beats\n\n{{beats}}\n\n{{#dm}}\n## What is really going on\n\n{{going}}\n{{/dm}}\n',
    target: { kind: 'page', path: 'Scenes/{{title}}', visibility: 'dm' },
  },
  {
    key: 'scene-player', name: 'Scene, player perspective', perspective: 'player',
    description: 'A read-aloud description built only from what the players can see. Checked for leaks before you read or send it.',
    fields: [
      { key: 'location', label: 'Location', type: 'page', hint: 'A library page the players can see', required: true },
      { key: 'time', label: 'Time', type: 'text', gen: 'clock' },
      { key: 'weather', label: 'Weather', type: 'text' },
      { key: 'mood', label: 'Mood', type: 'text' },
      { key: 'description', label: 'Read-aloud', type: 'longtext', hint: 'Two short paragraphs, second person, no secrets' },
    ],
    body: '*{{location}} · {{time}}*\n\n{{description}}\n',
    target: { kind: 'page', path: 'Scenes/{{location}} (read-aloud)', visibility: 'dm' },
  },
  {
    key: 'tavern', name: 'Tavern', perspective: 'dm',
    description: 'A tavern with a keeper, a feel, a house special, a rumour and a secret.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'keeper', label: 'Keeper', type: 'name' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'vibe', label: 'Vibe', type: 'text' },
      { key: 'special', label: 'House special', type: 'text' },
      { key: 'patrons', label: 'Patrons', type: 'list', hint: 'Three short patrons' },
      { key: 'rumor', label: 'Rumour', type: 'text' },
      { key: 'secret', label: 'Secret', type: 'text', dmOnly: true },
    ],
    body: '# {{name}}\n*Kept by {{keeper}} · {{location}}*\n\n{{vibe}}\n\n**House special.** {{special}}\n\n**Patrons**\n\n{{patrons}}\n\n**Rumour.** {{rumor}}\n\n{{#dm}}\n**Secret.** {{secret}}\n{{/dm}}\n',
    target: { kind: 'page', path: 'Places/{{name}}', visibility: 'dm' },
  },
  {
    key: 'quest-hook', name: 'Quest hook', perspective: 'dm',
    description: 'A short hook: who asks, what they ask, the stakes, the reward and a twist.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'giver', label: 'Quest giver', type: 'name' },
      { key: 'hook', label: 'The ask', type: 'longtext' },
      { key: 'stakes', label: 'Stakes', type: 'text' },
      { key: 'reward', label: 'Reward', type: 'coins' },
      { key: 'twist', label: 'Twist', type: 'text', dmOnly: true },
    ],
    body: '# {{title}}\n*Offered by {{giver}}*\n\n{{hook}}\n\n**Stakes.** {{stakes}}\n\n**Reward.** {{reward}}\n\n{{#dm}}\n**Twist.** {{twist}}\n{{/dm}}\n',
    target: { kind: 'page', path: 'Quests/{{title}}', visibility: 'dm' },
  },
];
