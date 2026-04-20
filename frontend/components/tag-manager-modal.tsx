'use client';

import React from 'react';
import { X as XIcon, Check, Plus, Trash2, Pencil } from 'lucide-react';
import { api } from '@/lib/api';

interface Tag {
  id: string;
  name: string;
  color: string;
  contact_count?: number;
  company_count?: number;
}

interface TagManagerModalProps {
  entityType: 'contact' | 'company';
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const TAG_COLORS = [
  '#D946A8', '#A855F7', '#3B82F6', '#06B6D4',
  '#22C55E', '#F59E0B', '#EF4444', '#F97316',
  '#EC4899', '#6366F1', '#14B8A6', '#888888',
];

export function TagManagerModal({ entityType, open, onClose, onChanged }: TagManagerModalProps) {
  const [tags, setTags] = React.useState<Tag[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const [colorPickerId, setColorPickerId] = React.useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');
  const [newColor, setNewColor] = React.useState('#D946A8');
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    api.listTags(entityType).then(d => setTags(d.tags as Tag[])).finally(() => setLoading(false));
  }, [entityType]);

  React.useEffect(() => { if (open) load(); }, [open, load]);

  function getCount(t: Tag): number {
    return entityType === 'contact' ? (t.contact_count || 0) : (t.company_count || 0);
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    await api.updateTag(id, { name: editName.trim() });
    setEditingId(null);
    load();
    onChanged();
  }

  async function handleColorChange(id: string, color: string) {
    await api.updateTag(id, { color });
    setColorPickerId(null);
    load();
    onChanged();
  }

  async function handleDelete(id: string) {
    await api.deleteTag(id);
    setDeleteConfirmId(null);
    load();
    onChanged();
  }

  async function handleCreate() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      await api.createTag({ name: newName.trim(), color: newColor, entity_type: entityType });
      setNewName('');
      load();
      onChanged();
    } catch { /* silent */ }
    setCreating(false);
  }

  if (!open) return null;

  const entityLabel = entityType === 'contact' ? 'contacts' : 'companies';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}>
      <div className="bg-bg-elevated rounded-2xl w-full max-w-md shadow-2xl border border-border"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="font-medium text-text-primary">Manage {entityType === 'contact' ? 'Contact' : 'Company'} Tags</div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <XIcon size={16} />
          </button>
        </div>

        <div className="max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-sm text-text-muted">Loading...</div>
          ) : tags.length === 0 ? (
            <div className="p-6 text-center text-sm text-text-muted">No tags yet</div>
          ) : (
            <div className="divide-y divide-border">
              {tags.map(tag => {
                const count = getCount(tag);
                return (
                  <div key={tag.id} className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setColorPickerId(colorPickerId === tag.id ? null : tag.id)}
                        className="w-4 h-4 rounded-full shrink-0 hover:scale-125 transition-transform cursor-pointer"
                        style={{ background: tag.color }} />

                      {editingId === tag.id ? (
                        <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(tag.id); if (e.key === 'Escape') setEditingId(null); }}
                          onBlur={() => handleRename(tag.id)}
                          className="flex-1 bg-bg-input text-text-primary text-sm rounded px-2 py-1 border border-border focus:border-accent-magenta focus:outline-none"
                          autoFocus />
                      ) : (
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-sm text-text-primary truncate">{tag.name}</span>
                          <span className="text-[10px] text-text-muted shrink-0">{count} {entityLabel}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => { setEditingId(tag.id); setEditName(tag.name); }}
                          className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/[0.06] transition-colors">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => setDeleteConfirmId(tag.id)}
                          className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {colorPickerId === tag.id && (
                      <div className="flex flex-wrap gap-1.5 mt-2 ml-7">
                        {TAG_COLORS.map(c => (
                          <button key={c} onClick={() => handleColorChange(tag.id, c)}
                            className="w-5 h-5 rounded-full transition-transform hover:scale-125 flex items-center justify-center"
                            style={{ background: c, boxShadow: tag.color === c ? `0 0 0 2px var(--bg-elevated), 0 0 0 3.5px ${c}` : 'none' }}>
                            {tag.color === c && <Check size={9} className="text-white" />}
                          </button>
                        ))}
                      </div>
                    )}

                    {deleteConfirmId === tag.id && (
                      <div className="mt-2 ml-7 p-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                        <div className="text-xs text-text-secondary mb-2">
                          Delete &ldquo;{tag.name}&rdquo;? This will remove it from {count} {entityLabel}.
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => handleDelete(tag.id)}
                            className="px-2.5 py-1 rounded text-[10px] font-medium bg-semantic-error text-white hover:bg-semantic-error/90 transition-colors">
                            Delete
                          </button>
                          <button onClick={() => setDeleteConfirmId(null)}
                            className="px-2.5 py-1 rounded text-[10px] font-medium text-text-muted hover:text-text-secondary transition-colors"
                            style={{ background: 'rgba(255,255,255,0.04)' }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="flex gap-1 shrink-0">
              {TAG_COLORS.slice(0, 6).map(c => (
                <button key={c} onClick={() => setNewColor(c)}
                  className="w-4 h-4 rounded-full transition-transform hover:scale-125 flex items-center justify-center"
                  style={{ background: c, boxShadow: newColor === c ? `0 0 0 2px var(--bg-elevated), 0 0 0 3px ${c}` : 'none' }}>
                  {newColor === c && <Check size={7} className="text-white" />}
                </button>
              ))}
            </div>
            <input type="text" placeholder="New tag name..." value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              className="flex-1 bg-bg-input text-text-primary text-xs rounded-lg px-3 py-2 border border-border focus:border-accent-magenta focus:outline-none" />
            <button onClick={handleCreate} disabled={creating || !newName.trim()}
              className="btn-primary text-xs px-3 py-2 flex items-center gap-1 disabled:opacity-50">
              <Plus size={12} /> Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
