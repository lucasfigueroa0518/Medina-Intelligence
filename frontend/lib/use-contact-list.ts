'use client';

import { api, ContactListResponse } from '@/lib/api';
import { createCachedList, ListPage, UseCachedListOptions } from '@/lib/use-cached-list';

const DEFAULT_PAGE_SIZE = 250;

type ContactListFacets = NonNullable<ContactListResponse['facets']>;

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

function toPage(res: ContactListResponse): ListPage<any> {
  return {
    items: res.contacts,
    total: res.total,
    hasMore: Boolean(res.next_cursor),
    nextCursor: res.next_cursor,
    extra: res.facets ?? null,
  };
}

const contactList = createCachedList<any>({
  namespace: 'contacts',
  mode: 'cursor',
  pageSize: DEFAULT_PAGE_SIZE,
  getItemId: contact => contact.id,
  fetchFirst: (params, signal) =>
    api.bootstrapContacts(params, signal ? { signal } : {}).then(toPage),
  fetchNext: (params, current, signal) =>
    api
      .listContacts({ ...params, cursor: String(current.nextCursor) }, signal ? { signal } : {})
      .then(toPage),
});

export function prewarmContactsList(params?: Record<string, string>): void {
  contactList.prewarm(params);
}

/** Invalidate every cached contacts page so the next read refetches. Used after
 *  a mutation (e.g. a contact edit) whose effect on filtered/sorted result sets
 *  can't be safely patched in place. */
export function invalidateContactsList(): void {
  contactList.invalidateAll();
}

/** Patch a single contact in place across cached pages so an edit shows up in
 *  the list immediately, without a refetch or waiting out the TTL. Returns true
 *  if the contact was present in at least one cached page. */
export function patchContactInList(contactId: string, patch: (contact: any) => any): boolean {
  return contactList.patchItem(contactId, patch);
}

export function useContactList(
  params: Record<string, string>,
  options: UseCachedListOptions = {},
): UseContactListState {
  const state = contactList.useList(params, {
    ...options,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  return {
    contacts: state.items,
    total: state.total,
    loading: state.loading,
    loadingMore: state.loadingMore,
    prefetching: state.prefetching,
    error: state.error,
    facets: (state.extra as ContactListFacets | null) || null,
    hasMore: state.hasMore,
    refresh: state.refresh,
    loadMore: state.loadMore,
  };
}
