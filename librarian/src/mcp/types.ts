// MCP Module System Types

export interface MCPStatus {
  name: string;
  version: string;
  status: 'healthy' | 'unhealthy' | 'loading';
  lastCheck: string;
}

export interface FindEntitiesParams {
  entity_type?: string;
  query?: string;
  name?: string;
  name_exact?: boolean;
  name_fuzzy?: boolean;
  type?: string;
  tags?: string[];
  date_range?: { start?: string; end?: string };
  limit?: number;
  page?: number;
  include_full?: boolean;
  last_synced?: string;
  [key: string]: any;
}

export interface EntityResult {
  entities: Entity[];
  sync_info?: {
    request_timestamp: string;
    newest_updated_at: string;
    total_count: number;
    last_page: number;
    returned_count: number;
  };
  [key: string]: any;
}

export interface Entity {
  id: string;
  entity_type: string;
  name: string;
  entry?: string;
  type?: string;
  tags?: string[];
  is_hidden?: boolean;
  created_at?: string;
  updated_at?: string;
  [key: string]: any;
}

export interface MapFeature {
  id?: string;
  map_id: string;
  type: 'pin' | 'label' | 'region' | 'path' | 'folder';
  name: string;
  description?: string;
  coordinates?: {
    latitude?: number;
    longitude?: number;
    x?: number;
    y?: number;
  };
  linked_page_id?: string;
  [key: string]: any;
}

export interface TimelineEvent {
  id?: string;
  timeline_id: string;
  name: string;
  description?: string;
  date?: string;
  lane?: string;
  [key: string]: any;
}

export interface PageContent {
  id: string;
  title: string;
  content: string;
  sections?: Section[];
  [key: string]: any;
}

export interface Section {
  heading: string;
  content: string;
}

export interface SearchOptions {
  world_type?: string;
  limit?: number;
  [key: string]: any;
}

export interface SearchResult {
  id: string;
  name: string;
  entity_type: string;
  relevance: number;
  preview: string;
  [key: string]: any;
}

export interface MCPModuleConfig {
  type: 'kanka' | 'legendkeeper' | 'generic';
  url?: string;
  apiUrl?: string;
  apiKey?: string;
  campaignId?: string;
  projectId?: string;
  [key: string]: any;
}
