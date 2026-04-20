'use client';

import React from 'react';
import { api } from '@/lib/api';

interface CompanyOption {
  id: string;
  name: string;
}

interface CompanySearchFieldProps {
  companyId: string | null;
  companyName: string;
  onChange: (companyId: string | null, companyName: string) => void;
  onCompanyCreated?: (name: string) => void;
  disabled?: boolean;
}

export function CompanySearchField({
  companyId,
  companyName,
  onChange,
  onCompanyCreated,
  disabled,
}: CompanySearchFieldProps) {
  const [query, setQuery] = React.useState(companyName);
  const [options, setOptions] = React.useState<CompanyOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout>>();

  React.useEffect(() => {
    setQuery(companyName);
  }, [companyName]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function search(term: string) {
    clearTimeout(debounceRef.current);
    setQuery(term);
    onChange(null, term);

    if (term.trim().length < 2) {
      setOptions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.listCompanies({ keyword: term.trim(), limit: '8' });
        setOptions(res.companies.map((c: any) => ({ id: c.id, name: c.name })));
        setOpen(true);
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
  }

  function selectCompany(c: CompanyOption) {
    setQuery(c.name);
    onChange(c.id, c.name);
    setOpen(false);
  }

  async function createAndSelect() {
    if (!query.trim() || creating) return;
    setCreating(true);
    try {
      const res = await api.createCompany({ name: query.trim() });
      const c = res.company;
      setQuery(c.name);
      onChange(c.id, c.name);
      setOpen(false);
      onCompanyCreated?.(c.name);
    } catch (err: any) {
      alert(err?.message || 'Failed to create company');
    } finally {
      setCreating(false);
    }
  }

  const exactMatch = options.some(
    o => o.name.toLowerCase() === query.trim().toLowerCase()
  );

  return (
    <div ref={containerRef} className="relative">
      <input
        className="input w-full"
        value={query}
        onChange={e => search(e.target.value)}
        onFocus={() => {
          if (options.length > 0 || query.trim().length >= 2) setOpen(true);
        }}
        placeholder="Search or create company..."
        disabled={disabled}
      />
      {companyId && (
        <button
          type="button"
          onClick={() => {
            setQuery('');
            onChange(null, '');
            setOptions([]);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-xs"
          disabled={disabled}
        >
          clear
        </button>
      )}
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-xl shadow-xl max-h-56 overflow-y-auto">
          {loading && (
            <div className="px-4 py-2 text-xs text-text-muted">Searching...</div>
          )}
          {options.map(o => (
            <button
              key={o.id}
              type="button"
              onClick={() => selectCompany(o)}
              className="w-full text-left px-4 py-2.5 text-sm text-text-primary hover:bg-bg-surface transition-colors first:rounded-t-xl last:rounded-b-xl"
            >
              {o.name}
            </button>
          ))}
          {!loading && query.trim().length >= 2 && !exactMatch && (
            <button
              type="button"
              onClick={createAndSelect}
              disabled={creating}
              className="w-full text-left px-4 py-2.5 text-sm text-accent-cyan hover:bg-bg-surface transition-colors border-t border-border"
            >
              {creating
                ? 'Creating...'
                : `+ Create "${query.trim()}"`}
            </button>
          )}
          {!loading && options.length === 0 && query.trim().length >= 2 && exactMatch && (
            <div className="px-4 py-2 text-xs text-text-muted">No companies found</div>
          )}
        </div>
      )}
    </div>
  );
}
