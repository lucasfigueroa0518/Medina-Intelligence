'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { api, streamAgentQuery } from '@/lib/api';
import { ArrowUp, Paperclip, Plus, Sparkles } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

const PROMPT_SUGGESTIONS = [
  'Summarize my meetings from this week',
  'Which portfolio companies raised concerns last quarter?',
  'Who haven\'t I spoken to in 30+ days?',
  'What\'s the latest on our Series B pipeline?',
];

export default function GodModePage() {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [attachedFile, setAttachedFile] = React.useState<File | null>(null);
  const messagesRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    api.listSessions().then(d => setSessions(d.sessions));
  }, []);

  React.useEffect(() => {
    if (activeSessionId) {
      api.getSessionMessages(activeSessionId).then(d =>
        setMessages(
          d.messages.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
          }))
        )
      );
    } else {
      setMessages([]);
    }
  }, [activeSessionId]);

  React.useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages]);

  const sendMessage = async (queryText: string) => {
    if (!queryText || streaming) return;
    setStreaming(true);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    setMessages(m => [
      ...m,
      { id: userMsgId, role: 'user', content: queryText },
      { id: assistantMsgId, role: 'assistant', content: '', streaming: true },
    ]);
    setInput('');

    const file = attachedFile;
    setAttachedFile(null);

    await streamAgentQuery(
      queryText,
      activeSessionId,
      null,
      null,
      file,
      token => {
        setMessages(m =>
          m.map(msg =>
            msg.id === assistantMsgId ? { ...msg, content: msg.content + token } : msg
          )
        );
      },
      () => {
        setMessages(m =>
          m.map(msg => (msg.id === assistantMsgId ? { ...msg, streaming: false } : msg))
        );
        setStreaming(false);
        api.listSessions().then(d => setSessions(d.sessions));
      },
      err => {
        setMessages(m =>
          m.map(msg =>
            msg.id === assistantMsgId
              ? { ...msg, content: `Error: ${err}`, streaming: false }
              : msg
          )
        );
        setStreaming(false);
      }
    );
  };

  return (
    <div className="flex-1 flex">
      {/* Sessions sidebar */}
      <aside className="w-[300px] bg-bg-inset border-r border-border flex flex-col">
        <div className="p-4">
          <button
            onClick={() => {
              setActiveSessionId(null);
              setMessages([]);
            }}
            className="btn-secondary w-full flex items-center justify-center gap-2"
          >
            <Plus size={16} /> New Session
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-bg-surface transition-colors ${
                activeSessionId === s.id
                  ? 'bg-bg-surface border-l-2 border-l-accent-magenta pl-[14px]'
                  : ''
              }`}
            >
              <div className="text-sm text-text-primary truncate">
                {s.title || 'New Session'}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {s.turn_count || 0} turns · {formatRelative(s.last_activity_at)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Chat area */}
      <main className="flex-1 flex flex-col">
        <TopBar title="God Mode" />

        <div ref={messagesRef} className="flex-1 overflow-y-auto px-8 py-6">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-6">
              <Sparkles size={64} className="text-text-muted opacity-30" />
              <div className="text-lg text-text-secondary">
                Ask anything about your firm's data
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-2xl w-full">
                {PROMPT_SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => sendMessage(s)}
                    className="card text-left text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-all"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-4">
              {messages.map(m =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="bg-bg-surface rounded-xl rounded-br-none px-5 py-3 max-w-[75%]">
                      <div className="text-sm text-text-primary whitespace-pre-wrap">
                        {m.content}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="max-w-[85%]">
                    <div className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
                      {m.content || (
                        <span className="flex gap-1">
                          <span className="streaming-dot">●</span>
                          <span className="streaming-dot" style={{ animationDelay: '0.2s' }}>
                            ●
                          </span>
                          <span className="streaming-dot" style={{ animationDelay: '0.4s' }}>
                            ●
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border bg-bg-root p-6">
          {attachedFile && (
            <div className="max-w-4xl mx-auto mb-2 flex items-center gap-2">
              <div className="badge">
                {attachedFile.name} ({Math.round(attachedFile.size / 1024)}KB)
              </div>
              <button
                onClick={() => setAttachedFile(null)}
                className="text-text-muted hover:text-text-primary text-xs"
              >
                ✕
              </button>
            </div>
          )}
          <div className="max-w-4xl mx-auto flex items-end gap-3">
            <label className="btn-ghost cursor-pointer p-2">
              <Paperclip size={18} />
              <input
                type="file"
                className="hidden"
                accept=".pdf,.docx,.csv,.txt,.md,.xlsx"
                onChange={e => setAttachedFile(e.target.files?.[0] || null)}
              />
            </label>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(input);
                }
              }}
              placeholder="Ask anything about your data..."
              rows={1}
              className="input flex-1 resize-none max-h-32"
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input || streaming}
              className="btn-primary p-2.5 rounded-lg"
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < 3600000) return 'Just now';
  if (diff < day) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}
