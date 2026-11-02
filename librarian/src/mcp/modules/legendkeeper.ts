import { MCPModule } from './base';
import { FindEntitiesParams, EntityResult, Entity, MapFeature, TimelineEvent, PageContent, SearchResult } from '../types';

export interface LegendKeeperConfig {
  apiUrl?: string;
  apiKey: string;
  projectId?: string;
  [key: string]: any;
}

export class LegendKeeperModule extends MCPModule {
  readonly name = 'legendkeeper';
  readonly version = '0.2.0';

  private apiUrl: string;
  private apiKey: string;
  private projectId?: string;

  constructor(config: LegendKeeperConfig) {
    super(config);
    this.apiUrl = config.apiUrl || 'https://www.legendkeeper.com/api/v3';
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
  }

  async health(): Promise<boolean> {
    try {
      const url = this.projectId 
        ? `${this.apiUrl}/projects/${this.projectId}`
        : `${this.apiUrl}/projects`;
        
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<string[]> {
    const response = await fetch(`${this.apiUrl}/projects`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return data.map((p: any) => p.name);
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    // LegendKeeper uses "resources" as entities
    const url = new URL(`${this.apiUrl}/resources`);
    if (this.projectId) url.searchParams.append('project_id', this.projectId);
    
    if (params.entity_type) url.searchParams.append('type', params.entity_type);
    if (params.name) url.searchParams.append('name', params.name);
    if (params.limit) url.searchParams.append('limit', params.limit.toString());
    if (params.page) url.searchParams.append('page', params.page.toString());

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      entities: data.resources || [],
      sync_info: {
        request_timestamp: new Date().toISOString(),
        newest_updated_at: data.resources?.[0]?.updated_at || '',
        total_count: data.total_count || 0,
        last_page: Math.ceil((data.total_count || 0) / (params.limit || 25)),
        returned_count: data.resources?.length || 0
      }
    };
  }

  async getEntity(entityId: string): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/resources/${entityId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return this.mapResourceToEntity(data);
  }

  async createEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: entity.name,
        type: entity.entity_type,
        entry: entity.entry,
        tags: entity.tags,
        is_hidden: entity.is_hidden
      })
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return this.mapResourceToEntity(data);
  }

  async updateEntity(entity: Entity): Promise<Entity> {
    const response = await fetch(`${this.apiUrl}/resources/${entity.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: entity.name,
        entry: entity.entry,
        tags: entity.tags,
        is_hidden: entity.is_hidden
      })
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return this.mapResourceToEntity(data);
  }

  async deleteEntity(entityId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/resources/${entityId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }
  }

  async getMapFeatures(mapId: string): Promise<MapFeature[]> {
    // Get map features via resources endpoint with map filter
    const url = new URL(`${this.apiUrl}/resources`);
    url.searchParams.append('type', 'map_feature');
    url.searchParams.append('map_id', mapId);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.resources || []).map(this.mapResourceToMapFeature.bind(this));
  }

  async createMapFeature(feature: MapFeature): Promise<MapFeature> {
    const response = await fetch(`${this.apiUrl}/resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: feature.name,
        type: 'map_feature',
        entry: feature.description,
        facts: {
          coordinates: feature.coordinates ? JSON.stringify(feature.coordinates) : '',
          map_id: feature.map_id
        }
      })
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return this.mapResourceToMapFeature(data);
  }

  async getTimelineEvents(timelineId: string): Promise<TimelineEvent[]> {
    const url = new URL(`${this.apiUrl}/resources`);
    url.searchParams.append('type', 'timeline_event');
    url.searchParams.append('timeline_id', timelineId);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.resources || []).map(this.mapResourceToTimelineEvent.bind(this));
  }

  async createTimelineEvent(event: TimelineEvent): Promise<TimelineEvent> {
    const response = await fetch(`${this.apiUrl}/resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: event.name,
        type: 'timeline_event',
        entry: event.description,
        facts: {
          timeline_id: event.timeline_id,
          date: event.date
        }
      })
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return this.mapResourceToTimelineEvent(data);
  }

  async readPage(pageId: string): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/resources/${pageId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      title: data.name,
      content: data.entry || '',
      sections: []
    };
  }

  async writePage(pageId: string, content: PageContent): Promise<PageContent> {
    const response = await fetch(`${this.apiUrl}/resources/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: content.title,
        entry: content.content
      })
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      title: data.name,
      content: data.entry || '',
      sections: []
    };
  }

  async search(query: string, options?: any): Promise<SearchResult[]> {
    const url = new URL(`${this.apiUrl}/search`);
    url.searchParams.append('q', query);
    if (this.projectId) url.searchParams.append('project_id', this.projectId);
    if (options?.limit) url.searchParams.append('limit', options.limit.toString());

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.resources || []).map((result: any) => ({
      id: result.id,
      name: result.name,
      entity_type: result.type,
      relevance: result.score || 100,
      preview: result.entry?.substring(0, 200) || ''
    }));
  }

  async getResource(resourceId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/resources/${resourceId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`LegendKeeper API error: ${response.status}`);
    }

    return await response.json();
  }

  async uploadImage(image: any): Promise<any> {
    // LegendKeeper image upload implementation
    throw new Error('Not implemented: LegendKeeper image upload');
  }

  // Helper methods to map between Kanka and LegendKeeper formats
  private mapResourceToEntity(resource: any): Entity {
    return {
      id: resource.id,
      entity_type: resource.type,
      name: resource.name,
      entry: resource.entry,
      type: resource.type,
      tags: resource.tags || [],
      is_hidden: resource.is_hidden,
      created_at: resource.created_at,
      updated_at: resource.updated_at
    };
  }

  private mapResourceToMapFeature(resource: any): MapFeature {
    const facts = resource.facts || {};
    const coordinates = facts.coordinates ? JSON.parse(facts.coordinates) : {};
    
    return {
      id: resource.id,
      map_id: facts.map_id || '',
      type: facts.type || 'pin',
      name: resource.name,
      description: resource.entry,
      coordinates: coordinates
    };
  }

  private mapResourceToTimelineEvent(resource: any): TimelineEvent {
    const facts = resource.facts || {};
    
    return {
      id: resource.id,
      timeline_id: facts.timeline_id || '',
      name: resource.name,
      description: resource.entry,
      date: facts.date
    };
  }
}
