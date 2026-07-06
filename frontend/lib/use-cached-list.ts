'use client';

import React from 'react';

// Shared list-fetch core, generalized from use-contact-list. Gives every list
// surface the same behavior that only contacts had before: a per-key TTL cache,
// in-flight de-dup, epoch invalidation, abort controllers, request-sequence
// guards, background prefetch of the remaining pages, and paginated "load more".
//
// Two pagination shapes are supported behind one interface:
//   - cursor: server returns next_cursor; pages are fetched with { cursor }.
//   - offset: server returns total; pages are fetched with { offset } and merge
//     until items.length >= total.
// Contacts stays on cursor; companies/documents use offset.

export const DEFAULT_LIST_CACHE_TTL_MS = 60_000;

export type PaginationMode = 'cursor' | 'offset';

export interface ListPage<Item> {
  items: Item[];
  total: number;
  hasMore: boolean;
  nextCursor?: string | null;
  // Anything the caller wants to carry through the cache (facets, etc.). The
  // core treats this as opaque and always exposes the latest page's value.
  extra?: unknown;
}

export interface CachedListConfig<Item> {
  /** Stable identifier for this list kind — namespaces the module-level cache so
   *  two different lists can never collide on the same params key. */
  namespace: string;
  mode: PaginationMode;
  pageSize: number;
  ttlMs?: number;
  getItemId: (item: Item) => string;
  /** Fetch the first page. `params` already carries limit; for offset mode it
   *  carries offset=0. */
  fetchFirst: (params: Record<string, string>, signal?: AbortSignal) => Promise<ListPage<Item>>;
  /** Fetch the page that follows `current`. Cursor mode passes { cursor }; offset
   *  mode passes { offset: current.items.length }. */
  fetchNext: (
    params: Record<string, string>,
    current: ListPage<Item>,
    signal?: AbortSignal,
  ) => Promise<ListPage<Item>>;
}

interface CacheEntry<Item> {
  data: ListPage<Item>;
  fetchedAt: number;
  complete: boolean;
}

/** A shared, in-flight bootstrap fetch. Its lifetime is decoupled from any
 *  single caller: the network request is driven by a detached AbortController
 *  the cache layer owns, and callers register/unregister interest via refcount.
 *  The underlying request is only aborted once every interested caller has
 *  aborted (refcount hits zero), so one caller bailing out never rejects the
 *  fetch for the survivors. */
interface InflightEntry<Item> {
  promise: Promise<ListPage<Item>>;
  controller: AbortController;
  refs: number;
}

interface Store<Item> {
  cache: Map<string, CacheEntry<Item>>;
  inflight: Map<string, InflightEntry<Item>>;
  epoch: Map<string, number>;
}

/** Rejection used to signal that a specific caller unsubscribed from a shared
 *  fetch (its own signal aborted). Carries name 'AbortError' so the existing
 *  only-swallow-if-AbortError catch logic treats it identically to a native
 *  fetch abort. It is NEVER surfaced to a caller whose own signal is still live. */
class CallerAbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

const stores = new Map<string, Store<any>>();

function storeFor<Item>(namespace: string): Store<Item> {
  let store = stores.get(namespace);
  if (!store) {
    store = { cache: new Map(), inflight: new Map(), epoch: new Map() };
    stores.set(namespace, store);
  }
  return store as Store<Item>;
}

function stableParams(
  params: Record<string, string> | undefined,
  pageSize: number,
  mode: PaginationMode,
): Record<string, string> {
  const next: Record<string, string> = { ...(params || {}) };
  next.limit = String(pageSize);
  delete next.cursor;
  // The cache key is the first page; offset mode always starts at 0.
  if (mode === 'offset') next.offset = '0';
  else delete next.offset;
  return next;
}

function paramsKey(namespace: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  return `${namespace}::${qs}`;
}

function mergePages<Item>(
  base: ListPage<Item>,
  page: ListPage<Item>,
  getItemId: (item: Item) => string,
): ListPage<Item> {
  const seen = new Set(base.items.map(getItemId));
  const items = [...base.items];
  for (const item of page.items) {
    const itemId = getItemId(item);
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    items.push(item);
  }
  return {
    items,
    total: page.total,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    extra: page.extra ?? base.extra,
  };
}

export interface UseCachedListOptions {
  enabled?: boolean;
  pageSize?: number;
}

export interface UseCachedListState<Item> {
  items: Item[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  prefetching: boolean;
  error: string | null;
  extra: unknown;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

/** Build a reusable hook + helpers for a specific list kind. Call this once per
 *  list at module scope (see use-contact-list / use-company-list). */
export function createCachedList<Item>(config: CachedListConfig<Item>) {
  const ttlMs = config.ttlMs ?? DEFAULT_LIST_CACHE_TTL_MS;
  const store = storeFor<Item>(config.namespace);

  function fetchBootstrap(
    params: Record<string, string>,
    key: string,
    signal?: AbortSignal,
  ): Promise<ListPage<Item>> {
    const cached = store.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return Promise.resolve(cached.data);

    // Share one in-flight network request across concurrent same-key callers.
    // The request is driven by a detached controller the cache layer owns — NOT
    // by the first caller's signal — so a caller bailing out cannot abort the
    // shared fetch for everyone still waiting on it.
    let entry = store.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const epoch = store.epoch.get(key) || 0;
      const created: InflightEntry<Item> = {
        controller,
        refs: 0,
        promise: config
          .fetchFirst(params, controller.signal)
          .then(data => {
            if ((store.epoch.get(key) || 0) === epoch) {
              store.cache.set(key, { data, fetchedAt: Date.now(), complete: !data.hasMore });
            }
            return data;
          })
          .finally(() => {
            if (store.inflight.get(key) === created) store.inflight.delete(key);
          }),
      };
      store.inflight.set(key, created);
      entry = created;
    }

    // No caller signal: the caller is fire-and-forget (prewarm). It shares the
    // fetch but never counts toward the refcount, so it can't keep the request
    // alive nor tear it down.
    if (!signal) return entry.promise;

    // A caller with a signal subscribes to the shared fetch. Its returned
    // promise resolves with the shared data unless ITS OWN signal aborts first,
    // in which case only this caller sees an AbortError — the shared fetch and
    // every other subscriber are untouched. The shared request is aborted only
    // when the last live subscriber unsubscribes (refcount hits zero).
    const active = entry;
    active.refs += 1;

    if (signal.aborted) {
      release(key, active);
      return Promise.reject(new CallerAbortError());
    }

    return new Promise<ListPage<Item>>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        release(key, active);
        reject(new CallerAbortError());
      };
      signal.addEventListener('abort', onAbort);
      active.promise.then(
        data => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release(key, active);
          resolve(data);
        },
        error => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release(key, active);
          reject(error);
        },
      );
    });
  }

  /** Drop one subscriber's interest in a shared fetch. When the last live
   *  subscriber lets go, abort the underlying network request so an orphaned
   *  fetch (every interested caller unmounted / navigated away) doesn't run to
   *  completion. Guarded against a stale entry that was already replaced. */
  function release(key: string, entry: InflightEntry<Item>): void {
    if (entry.refs > 0) entry.refs -= 1;
    if (entry.refs === 0 && store.inflight.get(key) === entry) {
      entry.controller.abort();
      store.inflight.delete(key);
    }
  }

  function invalidateKey(key: string): void {
    store.cache.delete(key);
    // Abort and drop any shared in-flight fetch for this key: the epoch bump
    // below already blocks its (now stale) result from populating the cache, so
    // let subscribers re-drive a fresh fetch on the new epoch rather than resolve
    // against a fetch we've decided is stale.
    const entry = store.inflight.get(key);
    if (entry) {
      store.inflight.delete(key);
      entry.controller.abort();
    }
    store.epoch.set(key, (store.epoch.get(key) || 0) + 1);
  }

  /** Drop every cached page for this list kind. Used after a mutation whose
   *  effect on filtered/sorted result sets is hard to patch in place. */
  function invalidateAll(): void {
    // Snapshot keys first: invalidateKey mutates both maps, so iterating them
    // live would skip or double-visit entries.
    const keys = new Set<string>([...store.cache.keys(), ...store.inflight.keys()]);
    for (const key of keys) invalidateKey(key);
  }

  /** Patch a single item in place across every cached page that contains it, so
   *  an edit is reflected immediately without waiting out the TTL or refetching.
   *  Returns true if the item was found in at least one page. */
  function patchItem(itemId: string, patch: (item: Item) => Item): boolean {
    let found = false;
    for (const [key, entry] of store.cache.entries()) {
      let changed = false;
      const items = entry.data.items.map(item => {
        if (config.getItemId(item) !== itemId) return item;
        changed = true;
        found = true;
        return patch(item);
      });
      if (changed) {
        store.cache.set(key, { ...entry, data: { ...entry.data, items } });
      }
    }
    return found;
  }

  function prewarm(params?: Record<string, string>, pageSize = config.pageSize): void {
    const stable = stableParams(params, pageSize, config.mode);
    const key = paramsKey(config.namespace, stable);
    void fetchBootstrap(stable, key).catch(() => {});
  }

  function useList(
    params: Record<string, string>,
    options: UseCachedListOptions = {},
  ): UseCachedListState<Item> {
    const enabled = options.enabled !== false;
    const pageSize = options.pageSize || config.pageSize;
    const stable = React.useMemo(
      () => stableParams(params, pageSize, config.mode),
      [params, pageSize],
    );
    const key = React.useMemo(() => paramsKey(config.namespace, stable), [stable]);
    const abortRef = React.useRef<AbortController | null>(null);
    const prefetchAbortRef = React.useRef<AbortController | null>(null);
    const requestSeqRef = React.useRef(0);
    const [version, setVersion] = React.useState(0);
    const [state, setState] = React.useState(() => {
      const cached = store.cache.get(key);
      return {
        data: cached?.data || null,
        loading: enabled && !cached,
        loadingMore: false,
        prefetching: false,
        error: null as string | null,
        complete: cached?.complete || false,
      };
    });

    const loadNextPage = React.useCallback(
      async (current: ListPage<Item>, signal?: AbortSignal): Promise<ListPage<Item>> => {
        if (!current.hasMore) return current;
        const page = await config.fetchNext(stable, current, signal);
        const merged = mergePages(current, page, config.getItemId);
        // Safety guard: if a page added no new items despite claiming hasMore
        // (a stuck cursor / repeated offset from a misbehaving backend), stop
        // rather than loop forever. A correct backend always makes progress.
        if (merged.hasMore && merged.items.length === current.items.length) {
          return { ...merged, hasMore: false };
        }
        return merged;
      },
      [stable],
    );

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
      const cached = store.cache.get(key);

      setState({
        data: cached?.data || null,
        loading: !cached,
        loadingMore: false,
        prefetching: false,
        error: null,
        complete: cached?.complete || false,
      });

      fetchBootstrap(stable, key, controller.signal)
        .then(data => {
          if (controller.signal.aborted || seq !== requestSeqRef.current) return;
          const complete = !data.hasMore;
          setState({ data, loading: false, loadingMore: false, prefetching: data.hasMore, error: null, complete });

          if (!data.hasMore) return;
          const prefetchController = new AbortController();
          prefetchAbortRef.current = prefetchController;
          void (async () => {
            let merged = data;
            while (merged.hasMore && !prefetchController.signal.aborted && seq === requestSeqRef.current) {
              merged = await loadNextPage(merged, prefetchController.signal);
              store.cache.set(key, { data: merged, fetchedAt: Date.now(), complete: !merged.hasMore });
              if (prefetchController.signal.aborted || seq !== requestSeqRef.current) return;
              setState(prev => ({
                ...prev,
                data: merged,
                prefetching: merged.hasMore,
                complete: !merged.hasMore,
              }));
            }
            if (!prefetchController.signal.aborted && seq === requestSeqRef.current) {
              setState(prev => ({ ...prev, prefetching: false, complete: true }));
            }
          })().catch(error => {
            // Only swallow an abort that is OURS (this prefetch pass's own
            // signal aborted). A foreign / spurious AbortError while our signal
            // is still live must surface, never leave the row silently stuck.
            if (isAbortError(error) && prefetchController.signal.aborted) return;
            if (seq !== requestSeqRef.current) return;
            setState(prev => ({ ...prev, prefetching: false, error: error?.message || 'Unable to prefetch' }));
          });
        })
        .catch(error => {
          // Only swallow an abort that is OURS (this effect's own controller
          // aborted — unmount / param change / enabled toggle). Any other
          // rejection, including an AbortError arriving while our own signal is
          // NOT aborted, must clear loading and surface a real error so the row
          // never wedges on "Loading…" forever. (With the detached shared-fetch
          // controller this path can no longer be reached by a sibling caller's
          // abort; the guard is the enforced invariant, not just a heuristic.)
          if (isAbortError(error) && controller.signal.aborted) return;
          if (seq !== requestSeqRef.current) return;
          setState(prev => ({
            ...prev,
            loading: false,
            loadingMore: false,
            prefetching: false,
            error: error?.message || 'Unable to load',
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
      if (!state.data?.hasMore || state.loadingMore) return;
      prefetchAbortRef.current?.abort();
      const controller = new AbortController();
      prefetchAbortRef.current = controller;
      setState(prev => ({ ...prev, loadingMore: true, prefetching: false, error: null }));
      loadNextPage(state.data, controller.signal)
        .then(data => {
          store.cache.set(key, { data, fetchedAt: Date.now(), complete: !data.hasMore });
          setState(prev => ({
            ...prev,
            data,
            loadingMore: false,
            complete: !data.hasMore,
          }));
        })
        .catch(error => {
          // loadNextPage runs against this call's own controller (not the shared
          // de-dup path), so an AbortError here is only ours when our controller
          // aborted (superseded by a newer loadMore / refresh / unmount). Any
          // other error surfaces so the button can't hang on "Loading more…".
          if (isAbortError(error) && controller.signal.aborted) return;
          setState(prev => ({
            ...prev,
            loadingMore: false,
            error: error?.message || 'Unable to load more',
          }));
        });
    }, [key, loadNextPage, state.data, state.loadingMore]);

    return {
      items: state.data?.items || [],
      total: state.data?.total || 0,
      loading: state.loading,
      loadingMore: state.loadingMore,
      prefetching: state.prefetching,
      error: state.error,
      extra: state.data?.extra ?? null,
      hasMore: Boolean(state.data?.hasMore),
      refresh,
      loadMore,
    };
  }

  return { useList, prewarm, invalidateAll, patchItem };
}
