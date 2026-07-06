'use client';

import { api } from '@/lib/api';
import { createCachedList, ListPage, UseCachedListOptions } from '@/lib/use-cached-list';

const DEFAULT_PAGE_SIZE = 50;

interface DocumentListResult {
  documents: any[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

interface UseDocumentListState {
  documents: any[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  prefetching: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

function toPage(res: DocumentListResult): ListPage<any> {
  const total = res.total ?? res.documents.length;
  const seen = (res.offset ?? 0) + res.documents.length;
  return {
    items: res.documents,
    total,
    hasMore: typeof res.has_more === 'boolean' ? res.has_more : seen < total,
  };
}

const documentList = createCachedList<any>({
  namespace: 'documents',
  mode: 'offset',
  pageSize: DEFAULT_PAGE_SIZE,
  getItemId: doc => doc.id,
  fetchFirst: (params, signal) =>
    api.listDocuments(params, signal ? { signal } : {}).then(toPage),
  fetchNext: (params, current, signal) =>
    api
      .listDocuments({ ...params, offset: String(current.items.length) }, signal ? { signal } : {})
      .then(toPage),
});

export function invalidateDocumentsList(): void {
  documentList.invalidateAll();
}

export function useDocumentList(
  params: Record<string, string>,
  options: UseCachedListOptions = {},
): UseDocumentListState {
  const state = documentList.useList(params, {
    ...options,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  return {
    documents: state.items,
    total: state.total,
    loading: state.loading,
    loadingMore: state.loadingMore,
    prefetching: state.prefetching,
    error: state.error,
    hasMore: state.hasMore,
    refresh: state.refresh,
    loadMore: state.loadMore,
  };
}
