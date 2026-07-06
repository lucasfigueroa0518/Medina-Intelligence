'use client';

import React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronUp, Loader2, Mail, MessageSquareText, Paperclip } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { api, type ConversationThreadResponse } from '@/lib/api';

type ThreadMessage = ConversationThreadResponse['thread']['messages'][number];

function fmtDate(value: string | null | undefined): string {
  if (!value) return 'Unknown date';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return 'Unknown date';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function senderLabel(message: ThreadMessage): string {
  return message.from_name || message.from_email || 'Unknown sender';
}

export default function ConversationThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const [data, setData] = React.useState<ConversationThreadResponse | null>(null);
  // Messages are accumulated separately so "load older" can prepend an older
  // page onto the newest window without refetching what's already displayed.
  const [messages, setMessages] = React.useState<ThreadMessage[]>([]);
  const [olderCursor, setOlderCursor] = React.useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [olderError, setOlderError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!id) return;
    setLoading(true);
    setError(null);
    setOlderError(null);
    setMessages([]);
    setOlderCursor(null);
    setHasMoreOlder(false);
    api.getConversationThread(id)
      .then(res => {
        if (cancelled) return;
        setData(res);
        setMessages(res.thread.messages);
        setOlderCursor(res.thread.older_cursor ?? null);
        setHasMoreOlder(!!res.thread.has_more_older);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setData(null);
          setError(e?.message || 'Thread unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  const loadOlder = React.useCallback(() => {
    if (!id || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    api.getConversationThread(id, { before: olderCursor })
      .then(res => {
        // Prepend the older page ahead of the messages already shown, dropping
        // any overlap by id so a repeated cursor can never duplicate a message.
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const older = res.thread.messages.filter(m => !seen.has(m.id));
          return [...older, ...prev];
        });
        setOlderCursor(res.thread.older_cursor ?? null);
        setHasMoreOlder(!!res.thread.has_more_older);
      })
      .catch((e: any) => {
        setOlderError(e?.message || 'Could not load older messages');
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, [id, olderCursor, loadingOlder]);

  const thread = data?.thread;

  return (
    <div className="flex-1 overflow-auto bg-bg-root text-text-primary">
      <TopBar
        title="Conversation Thread"
        breadcrumb={
          <div className="text-sm text-text-muted">
            <Link href="/god-mode" className="hover:text-text-primary">MARTy</Link>
            <span className="mx-1.5">/</span>
            <span className="text-text-secondary">{thread?.subject || 'Conversation'}</span>
          </div>
        }
      />

      <main className="mx-auto w-full max-w-5xl px-6 py-7 lg:px-8">
        <button
          type="button"
          onClick={() => router.back()}
          className="mb-5 inline-flex items-center gap-2 text-sm text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={16} /> Back
        </button>

        {loading ? (
          <div className="flex h-64 items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 animate-spin" size={18} /> Loading thread...
          </div>
        ) : error || !thread ? (
          <section className="rounded-xl border border-semantic-error/25 bg-semantic-error/10 p-5">
            <div className="mb-1 text-sm font-medium text-text-primary">Thread unavailable</div>
            <p className="text-sm leading-6 text-text-secondary">
              {error || 'This thread could not be found, or you do not have access to its message content.'}
            </p>
          </section>
        ) : (
          <div className="space-y-5">
            <section className="rounded-xl border border-border bg-bg-elevated/55 p-5 shadow-xl">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-text-muted">
                    <Mail size={13} className="text-accent-magenta" />
                    {thread.source || 'Outlook'}
                  </div>
                  <h1 className="font-display text-2xl leading-tight text-text-primary">{thread.subject || '(no subject)'}</h1>
                  <div className="mt-2 text-sm text-text-secondary">
                    {thread.message_count} message{thread.message_count === 1 ? '' : 's'} · Last activity {fmtDate(thread.last_sent_at)}
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              {hasMoreOlder && (
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-elevated/55 px-4 py-2 text-sm text-text-secondary transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingOlder ? (
                      <>
                        <Loader2 className="animate-spin" size={15} /> Loading older messages...
                      </>
                    ) : (
                      <>
                        <ChevronUp size={15} /> Load older messages
                      </>
                    )}
                  </button>
                  {olderError && (
                    <p className="text-xs text-semantic-error">{olderError}</p>
                  )}
                </div>
              )}
              {messages.map(message => {
                const body = message.body || message.body_preview || 'No readable body is available for this message.';
                return (
                  <article
                    key={message.id}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4"
                  >
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                          <MessageSquareText size={14} className="text-accent-magenta" />
                          <span className="truncate">{senderLabel(message)}</span>
                        </div>
                        {message.from_email && message.from_email !== message.from_name && (
                          <div className="mt-0.5 text-xs text-text-muted">{message.from_email}</div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
                        {message.has_attachments && <Paperclip size={13} />}
                        {fmtDate(message.sent_at)}
                      </div>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{body}</div>
                  </article>
                );
              })}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
