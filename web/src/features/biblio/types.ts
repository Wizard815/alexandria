export type Level = 'party' | 'broker' | 'dm' | 'classified';
export type FieldType = 'text' | 'long' | 'number' | 'date' | 'link' | 'links' | 'yesno';
export interface TemplateField { key: string; label: string; type: FieldType; gm?: boolean; rel?: string; help?: string }
export interface Template { id: string; name: string; icon: string; fields: TemplateField[]; builtin?: boolean; description?: string }

/** One article in the tree. Players get only the articles they may read, and no level. */
export interface TreeItem { id: string; pageId: string | null; parentId: string | null; position: number | null; title: string; template: string; icon: string | null; level?: Level; tags: string[]; summary?: string; rev?: number; updatedAt: string }

export interface Overview { articles: TreeItem[]; templates: Template[]; canEdit: boolean; gm: boolean; sourceId: string | null; trash?: number }

/** The article as stored: only the GM, in the app, gets it. */
export interface Article {
  id: string; parentId: string | null; position: number | null; title: string; template: string; icon: string | null; cover: string | null; summary: string;
  tags: string[]; aliases: string[]; fields: Record<string, string>; level: Level; knowledge: 'common' | 'local' | 'deep' | null; body: string; pageId: string | null;
  rev: number; createdAt: string; updatedAt: string; updatedBy: string | null; deletedAt?: string | null; importedFrom?: string | null;
}

export interface ArticleView {
  id: string; pageId: string; title: string; template: { id: string; name: string; icon: string }; page: any;
  parent: { id: string; title: string } | null; children: { id: string; title: string; icon: string | null; template: string }[];
  backlinks: { id: string; title: string; articleId: string | null }[]; updatedAt: string; article?: Article;
}

export const LEVEL_NAME: Record<Level, string> = { party: 'Players can read', broker: 'GM only (broker may sell)', dm: 'GM only', classified: 'Classified (no AI)' };
export const LEVEL_SHORT: Record<Level, string> = { party: 'Players', broker: 'Broker', dm: 'GM', classified: 'Classified' };
export const LEVELS: Level[] = ['party', 'broker', 'dm', 'classified'];
