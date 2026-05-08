'use client';

import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  accessor: (row: T) => React.ReactNode;
  sortable?: boolean;
  // When this column is sortable, sortKey is the value passed to onSort.
  // Defaults to `key` when omitted.
  sortKey?: string;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  emptyAction?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  getRowId?: (row: T) => string;
  // Active sort state. When set, the matching header renders an arrow.
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  // Click handler for sortable headers. Receives the column's sortKey
  // (or column.key if sortKey is omitted). The parent decides whether to
  // toggle direction or switch to a new sort.
  onSort?: (key: string) => void;
}

export function DataTable<T>({
  columns,
  data,
  loading,
  emptyMessage = 'No results',
  emptyAction,
  onRowClick,
  selectable,
  getRowId,
  sortKey,
  sortDir,
  onSort,
}: DataTableProps<T>) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  if (loading) {
    return (
      <div className="card p-0 overflow-hidden">
        <div className="divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-14 flex items-center px-4 animate-pulse">
              {columns.map(col => (
                <div
                  key={col.key}
                  className="h-4 bg-bg-surface-hover rounded mr-4"
                  style={{ width: col.width || '120px' }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="card py-16 flex flex-col items-center gap-4">
        <div className="text-text-secondary text-sm">{emptyMessage}</div>
        {emptyAction}
      </div>
    );
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div className="md:hidden divide-y divide-border/60">
        {data.map((row, i) => {
          const id = getRowId ? getRowId(row) : String(i);
          const titleColumn = columns[0];
          const detailColumns = columns.slice(1).filter(col => col.header);
          return (
            <div
              key={id}
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={() => onRowClick?.(row)}
              onKeyDown={e => {
                if (!onRowClick) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick(row);
                }
              }}
              className={`w-full text-left p-4 transition-colors ${
                onRowClick ? 'cursor-pointer active:bg-bg-surface-hover' : ''
              }`}
            >
              <div className="flex items-start gap-3">
                {selectable && (
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      setSelected(next);
                    }}
                    className="mt-1"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-primary font-medium min-w-0">
                    {titleColumn.accessor(row)}
                  </div>
                  {detailColumns.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {detailColumns.slice(0, 5).map(col => (
                        <div key={col.key} className="flex items-start justify-between gap-3 text-xs">
                          <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                            {col.header}
                          </span>
                          <div className="min-w-0 text-right text-text-secondary">
                            {col.accessor(row)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <table className="hidden md:table w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-bg-inset/50">
            {selectable && <th className="w-10 p-3" />}
            {columns.map(col => {
              const colSortKey = col.sortKey ?? col.key;
              const isActiveSort = !!col.sortable && sortKey === colSortKey;
              const clickable = !!col.sortable && !!onSort;
              return (
                <th
                  key={col.key}
                  className={`text-left px-4 py-3 text-xs font-medium uppercase tracking-wider ${
                    isActiveSort ? 'text-text-secondary' : 'text-text-muted'
                  } ${clickable ? 'cursor-pointer select-none hover:bg-bg-surface-hover/40 transition-colors' : ''}`}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={clickable ? () => onSort!(colSortKey) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {isActiveSort && (
                      sortDir === 'asc'
                        ? <ChevronUp size={12} className="text-text-secondary" />
                        : <ChevronDown size={12} className="text-text-secondary" />
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const id = getRowId ? getRowId(row) : String(i);
            return (
              <tr
                key={id}
                onClick={() => onRowClick?.(row)}
                className={`border-b border-border/50 transition-colors ${
                  onRowClick ? 'cursor-pointer hover:bg-bg-surface-hover' : ''
                }`}
              >
                {selectable && (
                  <td className="p-3" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      onChange={e => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        setSelected(next);
                      }}
                    />
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key} className="px-4 py-3 text-text-primary overflow-hidden" style={col.width ? { maxWidth: col.width } : undefined}>
                    {col.accessor(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
