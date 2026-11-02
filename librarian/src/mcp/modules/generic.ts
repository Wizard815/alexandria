import { MCPModule } from './base';
import { FindEntitiesParams, EntityResult, Entity, MapFeature, TimelineEvent, PageContent, SearchResult } from '../types';

export interface GenericConfig {
  apiUrl: string;
  apiKey?: string;
  [key: string]: any;
}

export class GenericModule extends MCPModule {
  readonly name = 'generic';
  readonly version = '1.0.0';

  private apiUrl: string;
  private apiKey?: string;

  constructor(config: GenericConfig) {
    super(config);
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    const response = await fetch(`${this.apiUrl}/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    const data = await response.json();
    return {
      entities: data.entities || [],
      sync_info: {
        request_timestamp: new Date().toISOString(),
        newest_updated_at: data.entities?.[0]?.updated_at || '',
        total_count: data.total_count || 0,
        last_page: data.last_page || 1,
        returned_count: data.entities?.length || 0
      }
    };
  }

  async getEntity(entityId: string): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/entities/${entityId}`, {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async createEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(entity)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async updateEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/entities/${entity.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(entity)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async deleteEntity(entityId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/entities/${entityId}`, {
      method: 'DELETE',
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }
  }

  async getMapFeatures(mapId: string): Promise<MapFeature[]> {
    const response = await fetch(`${this.apiUrl}/maps/${mapId}/features`, {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    const data = await response.json();
    return data.features || [];
  }

  async createMapFeature(feature: MapFeature): Promise<MapFeature> {
    const response = await fetch(`${this.apiUrl}/maps/${feature.map_id}/features`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(feature)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async getTimelineEvents(timelineId: string): Promise<TimelineEvent[]> {
    const response = await fetch(`${this.apiUrl}/timelines/${timelineId}/events`, {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    const data = await response.json();
    return data.events || [];
  }

  async createTimelineEvent(event: TimelineEvent): Promise<TimelineEvent> {
    const response = await fetch(`${this.apiUrl}/timelines/${event.timeline_id}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async readPage(pageId: string): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/pages/${pageId}`, {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async writePage(pageId: string, content: PageContent): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(content)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async search(query: string, options?: any): Promise<SearchResult[]> {
    const url = new URL(`${this.apiUrl}/search`);
    url.searchParams.append('query', query);
    if (options?.limit) url.searchParams.append('limit', options.limit.toString());

    const response = await fetch(url.toString(), {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    const data = await response.json();
    return (data.results || []).map((result: any) => ({
      id: result.id,
      name: result.name,
      entity_type: result.entity_type,
      relevance: result.score || 100,
      preview: result.preview || ''
    }));
  }

  async getResource(resourceId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/resources/${resourceId}`, {
      headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  async uploadImage(image: any): Promise<any> {
    const response = await fetch(`${this.apiUrl}/images`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(image)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }
}
