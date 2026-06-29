'use client';

import React from 'react';
import { api, ContactListResponse } from '@/lib/api';

const DEFAULT_PAGE_SIZE = 250;
const CACHE_TTL_MS = 60_000;

type ContactListFacets = NonNullable<ContactListResponse['facets']>;

interface CacheEntry {
  data: ContactListResponse;
  fetchedAt: number;
  complete: boolean;
}

interface UseContactListOptions {
  enabled?: boolean;
  pageSize?: number;
}

interface UseContactListState {
  contacts: any[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  prefetching: boolean;
  error: string | null;
  facets: ContactListFacets | null;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ContactListResponse>>();
const cacheEpoch = new Map<string, number>();

function stableParams(params: Record<string, string> | undefined, pageSize: number): Record<string, string> {
  const next: Record<string, string> = { ...(params || {}) };
  next.limit = String(pageSize);
  delete next.offset;
  delete next.cursor;
  return next;
}

function paramsKey(params: Record<string, string>): string {
  return new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  ).toString();
}

function mergePages(base: ContactListResponse, page: ContactListResponse): ContactListResponse {
  const seen = new Set(base.contacts.map(contact => contact.id));
  const contacts = [...base.contacts];
  for (const contact of page.contacts) {
    if (seen.has(contact.id)) continue;
    seen.add(contact.id);
    contacts.push(contact);
  }
  return {
    ...base,
    contacts,
    total: page.total,
    has_more: page.has_more,
    next_cursor: page.next_cursor,
  };
}

async function fetchBootstrap(params: Record<string, string>, signal?: AbortSignal): Promise<ContactListResponse> {
  const key = paramsKey(params);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const existing = inflight.get(key);
  if (existing) return existing;

  const epoch = cacheEpoch.get(key) || 0;
  let promise: Promise<ContactListResponse>;
  promise = api.bootstrapContacts(params, signal ? { signal } : {})
    .then(data => {
      if ((cacheEpoch.get(key) || 0) === epoch) {
        cache.set(key, { data, fetchedAt: Date.now(), complete: !data.next_cursor });
      }
      return data;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

function invalidateKey(key: string): void {
  cache.delete(key);
  inflight.delete(key);
  cacheEpoch.set(key, (cacheEpoch.get(key) || 0) + 1);
}

export function prewarmContactsList(params?: Record<string, string>): void {
  const stable = stableParams(params, DEFAULT_PAGE_SIZE);
  void fetchBootstrap(stable).catch(() => {});
}

export function useContactList(
  params: Record<string, string>,
  options: UseContactListOptions = {}
): UseContactListState {
  const enabled = options.enabled !== false;
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const stable = React.useMemo(() => stableParams(params, pageSize), [params, pageSize]);
  const key = React.useMemo(() => paramsKey(stable), [stable]);
  const abortRef = React.useRef<AbortController | null>(null);
  const prefetchAbortRef = React.useRef<AbortController | null>(null);
  const requestSeqRef = React.useRef(0);
  const [version, setVersion] = React.useState(0);
  const [state, setState] = React.useState(() => {
    const cached = cache.get(key);
    return {
      data: cached?.data || null,
      loading: enabled && !cached,
      loadingMore: false,
      prefetching: false,
      error: null as string | null,
      complete: cached?.complete || false,
    };
  });

  const loadNextPage = React.useCallback(async (
    current: ContactListResponse,
    signal?: AbortSignal
  ): Promise<ContactListResponse> => {
    if (!current.next_cursor) return current;
    const page = await api.listContacts({
      ...stable,
      cursor: current.next_cursor,
    }, signal ? { signal } : {});
    return mergePages(current, page);
  }, [stable]);

  React.useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      prefetchAbortRef.current?.abort();
      setState(prev => ({ ...prev, loading: false, loadingMore: false, prefetching: false, error: null }));
      return;
    }

    abortRef.current?.abort();
    prefetchAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const cached = cache.get(key);

    setState({
      data: cached?.data || null,
      loading: !cached,
      loadingMore: false,
      prefetching: false,
      error: null,
      complete: cached?.complete || false,
    });

    fetchBootstrap(stable, controller.signal)
      .then(data => {
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        const complete = !data.next_cursor;
        setState({ data, loading: false, loadingMore: false, prefetching: Boolean(data.next_cursor), error: null, complete });

        if (!data.next_cursor) return;
        const prefetchController = new AbortController();
        prefetchAbortRef.current = prefetchController;
        void (async () => {
          let merged = data;
          while (merged.next_cursor && !prefetchController.signal.aborted && seq === requestSeqRef.current) {
            merged = await loadNextPage(merged, prefetchController.signal);
            cache.set(key, { data: merged, fetchedAt: Date.now(), complete: !merged.next_cursor });
            if (prefetchController.signal.aborted || seq !== requestSeqRef.current) return;
            setState(prev => ({
              ...prev,
              data: merged,
              prefetching: Boolean(merged.next_cursor),
              complete: !merged.next_cursor,
            }));
          }
          if (!prefetchController.signal.aborted && seq === requestSeqRef.current) {
            setState(prev => ({ ...prev, prefetching: false, complete: true }));
          }
        })().catch(error => {
          if ((error as any)?.name === 'AbortError') return;
          if (seq !== requestSeqRef.current) return;
          setState(prev => ({ ...prev, prefetching: false, error: error?.message || 'Unable to prefetch contacts' }));
        });
      })
      .catch(error => {
        if ((error as any)?.name === 'AbortError') return;
        if (seq !== requestSeqRef.current) return;
        setState(prev => ({
          ...prev,
          loading: false,
          loadingMore: false,
          prefetching: false,
          error: error?.message || 'Unable to load contacts',
        }));
      });

    return () => {
      controller.abort();
      prefetchAbortRef.current?.abort();
    };
  }, [enabled, key, stable, loadNextPage, version]);

  const refresh = React.useCallback(() => {
    invalidateKey(key);
    setVersion(v => v + 1);
  }, [key]);

  const loadMore = React.useCallback(() => {
    if (!state.data?.next_cursor || state.loadingMore) return;
    prefetchAbortRef.current?.abort();
    const controller = new AbortController();
    prefetchAbortRef.current = controller;
    setState(prev => ({ ...prev, loadingMore: true, prefetching: false, error: null }));
    loadNextPage(state.data, controller.signal)
      .then(data => {
        cache.set(key, { data, fetchedAt: Date.now(), complete: !data.next_cursor });
        setState(prev => ({
          ...prev,
          data,
          loadingMore: false,
          complete: !data.next_cursor,
        }));
      })
      .catch(error => {
        if ((error as any)?.name === 'AbortError') return;
        setState(prev => ({
          ...prev,
          loadingMore: false,
          error: error?.message || 'Unable to load more contacts',
        }));
      });
  }, [key, loadNextPage, state.data, state.loadingMore]);

  return {
    contacts: state.data?.contacts || [],
    total: state.data?.total || 0,
    loading: state.loading,
    loadingMore: state.loadingMore,
    prefetching: state.prefetching,
    error: state.error,
    facets: state.data?.facets || null,
    hasMore: Boolean(state.data?.next_cursor),
    refresh,
    loadMore,
  };
}
