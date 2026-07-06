'use client';

import { api } from '@/lib/api';
import { createCachedList, ListPage, UseCachedListOptions } from '@/lib/use-cached-list';

const DEFAULT_PAGE_SIZE = 100;

interface CompanyListResult {
  companies: any[];
  limit: number;
  offset: number;
  total: number;
  has_more?: boolean;
}

interface UseCompanyListState {
  companies: any[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  prefetching: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

function toPage(res: CompanyListResult): ListPage<any> {
  const total = res.total ?? res.companies.length;
  // Offset pagination: derive hasMore from how many rows we've seen so far.
  const seen = (res.offset ?? 0) + res.companies.length;
  return {
    items: res.companies,
    total,
    hasMore: typeof res.has_more === 'boolean' ? res.has_more : seen < total,
  };
}

const companyList = createCachedList<any>({
  namespace: 'companies',
  mode: 'offset',
  pageSize: DEFAULT_PAGE_SIZE,
  getItemId: company => company.id,
  fetchFirst: (params, signal) =>
    api.listCompanies(params, signal ? { signal } : {}).then(toPage),
  fetchNext: (params, current, signal) =>
    api
      .listCompanies({ ...params, offset: String(current.items.length) }, signal ? { signal } : {})
      .then(toPage),
});

export function prewarmCompaniesList(params?: Record<string, string>): void {
  companyList.prewarm(params);
}

export function invalidateCompaniesList(): void {
  companyList.invalidateAll();
}

export function useCompanyList(
  params: Record<string, string>,
  options: UseCachedListOptions = {},
): UseCompanyListState {
  const state = companyList.useList(params, {
    ...options,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  return {
    companies: state.items,
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
