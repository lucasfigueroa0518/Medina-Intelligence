import { formatSourceLine, type CitationSource, type CitationSourceType } from './citations';

type MutableJson = Record<string, any> | any[];

function sourceKey(source: Partial<CitationSource>): string {
  const table = String(source.source_table || source.type || 'unknown');
  const id = String(source.source_id || source.entity_id || `${source.title || 'source'}::${source.date || ''}`);
  return `${table}::${id}`;
}

function normalizeToolSource(raw: any, fallbackId: number): CitationSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = normalizeSourceType(raw.type);
  if (!type) return null;
  const sourceTable = String(raw.source_table || tableForType(type));
  const sourceId = String(raw.source_id || raw.id || raw.entity_id || `${type}-${fallbackId}-${raw.title || 'source'}`);
  return {
    id: fallbackId,
    type,
    source_table: sourceTable,
    source_id: sourceId,
    entity_id: raw.entity_id,
    title: String(raw.title || raw.name || `${type} source`),
    subtitle: raw.subtitle,
    date: raw.date || raw.start_time || raw.created_at,
    url_path: raw.url_path || defaultUrlPath(sourceTable, sourceId),
    external_url: raw.external_url,
    excerpt: raw.excerpt || raw.summary || raw.description || raw.transcript_excerpt,
    entity_name: raw.entity_name,
    entity_url_path: raw.entity_url_path,
  };
}

function sourceFromEvent(event: any, fallbackId: number): CitationSource | null {
  if (!event?.id) return null;
  return {
    id: fallbackId,
    type: 'meeting',
    source_table: 'events',
    source_id: String(event.id),
    title: String(event.title || 'Meeting / event'),
    subtitle: event.event_type || event.source,
    date: event.start_time,
    url_path: `/events/${event.id}`,
    excerpt: event.transcript_excerpt || event.summary || event.description || event.topics_discussed,
  };
}

function normalizeSourceType(type: unknown): CitationSourceType | null {
  const value = String(type || '').toLowerCase();
  if (['email', 'meeting', 'document', 'contact', 'company', 'slack', 'news'].includes(value)) {
    return value as CitationSourceType;
  }
  return null;
}

function tableForType(type: CitationSourceType): string {
  if (type === 'meeting') return 'events';
  if (type === 'email' || type === 'slack') return 'conversations';
  if (type === 'contact') return 'contacts';
  if (type === 'company') return 'companies';
  if (type === 'news') return 'news_articles';
  return 'documents';
}

function defaultUrlPath(table: string, id: string): string {
  if (table === 'contacts') return `/contacts/${id}`;
  if (table === 'companies') return `/companies/${id}`;
  if (table === 'deals') return `/deals/${id}`;
  if (table === 'documents') return `/documents/${id}`;
  if (table === 'events') return `/events/${id}`;
  return '/';
}

export class TurnSourceRegistry {
  private sources: CitationSource[] = [];
  private keyToId = new Map<string, number>();

  constructor(initialSources: CitationSource[] = []) {
    for (const source of initialSources) this.addSource(source);
  }

  all(): CitationSource[] {
    return [...this.sources].sort((a, b) => a.id - b.id);
  }

  idSet(): Set<number> {
    return new Set(this.sources.map(s => s.id));
  }

  formatSourceLines(sources: CitationSource[] = this.all()): string {
    const nowMs = Date.now();
    return sources.map(source => formatSourceLine(source, nowMs)).join('\n');
  }

  addSource(source: CitationSource): { source: CitationSource; isNew: boolean } {
    const key = sourceKey(source);
    const existingId = this.keyToId.get(key);
    if (existingId) {
      const existing = this.sources.find(s => s.id === existingId)!;
      return { source: existing, isNew: false };
    }
    const nextId = this.sources.length > 0
      ? Math.max(...this.sources.map(s => s.id)) + 1
      : 1;
    const normalized = { ...source, id: nextId };
    this.sources.push(normalized);
    this.keyToId.set(key, nextId);
    return { source: normalized, isNew: true };
  }

  addSources(sources: CitationSource[]): CitationSource[] {
    const added: CitationSource[] = [];
    for (const source of sources) {
      const result = this.addSource(source);
      if (result.isNew) added.push(result.source);
    }
    return added;
  }

  appendToolResult(toolName: string, result: any): { result: any; delta: CitationSource[] } {
    const clone = cloneJson(result);
    const markerMap = new Map<string, string>();
    const added: CitationSource[] = [];

    if (Array.isArray(clone?.sources)) {
      clone.sources = clone.sources.map((raw: any, index: number) => {
        const source = normalizeToolSource(raw, this.sources.length + index + 1);
        if (!source) return raw;
        const registered = this.addSource(source);
        if (registered.isNew) added.push(registered.source);
        if (raw.citation_marker) markerMap.set(String(raw.citation_marker), `[^${registered.source.id}]`);
        return { ...raw, ...registered.source, citation_marker: `[^${registered.source.id}]` };
      });
    }

    if (Array.isArray(clone?.events)) {
      clone.events = clone.events.map((event: any, index: number) => {
        const source = sourceFromEvent(event, this.sources.length + index + 1);
        if (!source) return event;
        const registered = this.addSource(source);
        if (registered.isNew) added.push(registered.source);
        return { ...event, citation_marker: `[^${registered.source.id}]` };
      });
    }

    if (markerMap.size > 0) replaceMarkers(clone, markerMap);
    if (added.length > 0) {
      clone.sources_delta = added;
      clone.source_registry_note = `${toolName} appended ${added.length} source(s) to the turn citation registry. Cite these using their new [^N] markers only.`;
    }
    return { result: clone, delta: added };
  }
}

function cloneJson<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function replaceMarkers(value: MutableJson, markerMap: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') {
        value[i] = replaceMarkerString(value[i], markerMap);
      } else {
        replaceMarkers(value[i], markerMap);
      }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === 'citation_marker') continue;
    if (typeof value[key] === 'string') {
      value[key] = replaceMarkerString(value[key], markerMap);
    } else if (value[key] && typeof value[key] === 'object') {
      replaceMarkers(value[key], markerMap);
    }
  }
}

function replaceMarkerString(text: string, markerMap: Map<string, string>): string {
  return text.replace(/\[\^(\d+)(?:\s+[^\]]+)?\]/g, marker => markerMap.get(marker) || marker);
}
