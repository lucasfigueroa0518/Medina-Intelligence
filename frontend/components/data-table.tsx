'use client';

import React from 'react';

export interface Column<T> {
  key: string;
  header: string;
  accessor: (row: T) => React.ReactNode;
  sortable?: boolean;
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-bg-inset/50">
            {selectable && <th className="w-10 p-3" />}
            {columns.map(col => (
              <th
                key={col.key}
                className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider text-text-muted"
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
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
