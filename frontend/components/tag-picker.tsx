'use client';

import React from 'react';
import { Plus, X as XIcon, Check } from 'lucide-react';
import { api } from '@/lib/api';

interface Tag {
  id: string;
  name: string;
  color: string;
  entity_type?: string;
}

interface TagPickerProps {
  entityType: 'contact' | 'company';
  entityId: string;
  tags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
}

export function TagPicker({ entityType, entityId, tags, onTagsChange }: TagPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [search, setSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [newTagColor, setNewTagColor] = React.useState('#D946A8');
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const TAG_COLORS = [
    '#D946A8', '#A855F7', '#3B82F6', '#06B6D4',
    '#22C55E', '#F59E0B', '#EF4444', '#F97316',
    '#EC4899', '#6366F1', '#14B8A6', '#888888',
  ];

  React.useEffect(() => {
    if (open) {
      api.listTags(entityType).then(d => setAllTags(d.tags as Tag[]));
    }
  }, [open, entityType]);

  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const appliedIds = new Set(tags.map(t => t.id));
  const filtered = allTags.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );
  const exactMatch = allTags.some(t => t.name.toLowerCase() === search.trim().toLowerCase());

  async function toggleTag(tag: Tag) {
    if (appliedIds.has(tag.id)) {
      try {
        if (entityType === 'contact') await api.removeContactTag(entityId, tag.id);
        else await api.removeCompanyTag(entityId, tag.id);
        onTagsChange(tags.filter(t => t.id !== tag.id));
      } catch { /* silent */ }
    } else {
      try {
        if (entityType === 'contact') await api.applyContactTags(entityId, [tag.id]);
        else await api.applyCompanyTags(entityId, [tag.id]);
        onTagsChange([...tags, tag]);
      } catch { /* silent */ }
    }
  }

  async function removeTag(tagId: string) {
    try {
      if (entityType === 'contact') await api.removeContactTag(entityId, tagId);
      else await api.removeCompanyTag(entityId, tagId);
      onTagsChange(tags.filter(t => t.id !== tagId));
    } catch { /* silent */ }
  }

  async function createAndApply() {
    const name = search.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const { tag } = await api.createTag({ name, color: newTagColor, entity_type: entityType });
      if (entityType === 'contact') await api.applyContactTags(entityId, [tag.id]);
      else await api.applyCompanyTags(entityId, [tag.id]);
      onTagsChange([...tags, tag]);
      setAllTags(prev => [...prev, tag]);
      setSearch('');
    } catch { /* silent */ }
    setCreating(false);
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap relative">
      {tags.map(t => (
        <span key={t.id} className="group inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium cursor-default transition-all"
          style={{ background: t.color + '25', color: t.color }}>
          {t.name}
          <button onClick={() => removeTag(t.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
            aria-label={`Remove ${t.name}`}>
            <XIcon size={10} />
          </button>
        </span>
      ))}
      <div className="relative" ref={dropdownRef}>
        <button onClick={() => setOpen(!open)}
          className="w-5 h-5 rounded flex items-center justify-center transition-colors hover:bg-white/[0.08] text-text-muted hover:text-text-secondary"
          aria-label="Add tag">
          <Plus size={12} />
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 z-50 w-52 rounded-xl shadow-2xl overflow-hidden"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="p-2">
              <input type="text" placeholder="Search or create..."
                value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && search.trim() && !exactMatch) createAndApply(); }}
                className="w-full bg-bg-input text-text-primary text-xs rounded-lg px-3 py-2 border border-border focus:border-accent-magenta focus:outline-none"
                autoFocus />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filtered.map(tag => (
                <button key={tag.id} onClick={() => toggleTag(tag)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-white/[0.04]">
                  <span className="w-3 h-3 rounded-sm flex items-center justify-center shrink-0"
                    style={{ background: appliedIds.has(tag.id) ? tag.color : 'transparent', border: `1.5px solid ${tag.color}` }}>
                    {appliedIds.has(tag.id) && <Check size={8} className="text-white" />}
                  </span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                  <span className="text-text-primary truncate">{tag.name}</span>
                </button>
              ))}
              {search.trim() && !exactMatch && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1">
                    {TAG_COLORS.map(c => (
                      <button key={c} onClick={() => setNewTagColor(c)}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-125 flex items-center justify-center"
                        style={{ background: c, boxShadow: newTagColor === c ? `0 0 0 2px #1A1A1F, 0 0 0 3.5px ${c}` : 'none' }}>
                        {newTagColor === c && <Check size={8} className="text-white" />}
                      </button>
                    ))}
                  </div>
                  <button onClick={createAndApply} disabled={creating}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/[0.04] transition-colors">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: newTagColor }} />
                    <span style={{ color: newTagColor }}>Create &ldquo;{search.trim()}&rdquo;</span>
                  </button>
                </div>
              )}
              {filtered.length === 0 && !search.trim() && (
                <div className="px-3 py-4 text-xs text-text-muted text-center">No tags yet</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
