// What the DM calls each model job: the AI role names (labels only; job ids stay the same everywhere else).
export const ROLE_NAMES: Record<string, string> = {
  dm: 'Minerva', chat: 'Chat (default)', player: 'The Broker', helper: 'Squire', audit: 'Audit', bible: 'Story bible',
  extra: 'Historian', rerank: 'Arbiter', vision: 'Oracle', audio: 'Speech to text', voice: 'Voice',
};
export const ROLE_USES: Record<string, string> = {
  dm: 'Your assistant at the table.',
  chat: 'The default model: every role left on “same as Chat” uses it.',
  player: 'What players ask: the broker and their table helper.',
  helper: 'The players’ quick helper: a small model, 4B or less.',
  audit: 'Quick yes/no checks: question routing and spoiler checks. A small model is fine.',
  bible: 'Reads pages into the story bible as facts. A chat model, run in the background.',
  extra: 'Embeddings for search and the story bible. Keep it on nomic-embed-text-v1.5.',
  rerank: 'Optional: reorders the top search results.',
  vision: 'Looks at maps and pictures.',
};
export const roleName = (job: string) => ROLE_NAMES[job] ?? job;

export interface JobHealth { job: string; state: 'fallback' | 'down'; since: string; model: string; using?: string; provider?: string | null; usingProvider?: string | null; error: string }
/** "qwen3-8b on Spare box" */
export const onWhat = (model: string | undefined, provider: string | null | undefined) => `${model ?? '?'}${provider ? ` on ${provider}` : ''}`;
