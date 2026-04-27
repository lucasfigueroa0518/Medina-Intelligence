'use client';

import React from 'react';
import { Loader2, Check, X as XIcon, ChevronDown, ChevronUp, Minimize2 } from 'lucide-react';

type TaskStatus = 'running' | 'success' | 'error';

interface BackgroundTask {
  id: string;
  name: string;
  status: TaskStatus;
  resultText?: string;
  errorText?: string;
  startedAt: number;
}

interface BackgroundTaskContextValue {
  tasks: BackgroundTask[];
  startTask: <T>(name: string, promise: Promise<T>, formatResult?: (result: T) => string) => void;
  dismissTask: (id: string) => void;
  isRunning: (name: string) => boolean;
}

const BackgroundTaskContext = React.createContext<BackgroundTaskContextValue | null>(null);

export function useBackgroundTasks(): BackgroundTaskContextValue {
  const ctx = React.useContext(BackgroundTaskContext);
  if (!ctx) throw new Error('useBackgroundTasks must be used within BackgroundTaskProvider');
  return ctx;
}

export function BackgroundTaskProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = React.useState<BackgroundTask[]>([]);

  const startTask = React.useCallback(<T,>(
    name: string,
    promise: Promise<T>,
    formatResult?: (result: T) => string,
  ) => {
    const id = `${name}-${Date.now()}`;
    const task: BackgroundTask = { id, name, status: 'running', startedAt: Date.now() };
    setTasks(prev => [...prev, task]);

    promise
      .then(result => {
        const resultText = formatResult ? formatResult(result) : 'Completed';
        setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'success' as const, resultText } : t));
      })
      .catch(err => {
        const errorText = err?.message || String(err);
        setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'error' as const, errorText } : t));
      });
  }, []);

  const dismissTask = React.useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  const isRunning = React.useCallback((name: string) => {
    return tasks.some(t => t.name === name && t.status === 'running');
  }, [tasks]);

  const value = React.useMemo(
    () => ({ tasks, startTask, dismissTask, isRunning }),
    [tasks, startTask, dismissTask, isRunning],
  );

  return (
    <BackgroundTaskContext.Provider value={value}>
      {children}
    </BackgroundTaskContext.Provider>
  );
}

export function BackgroundTaskIndicator() {
  const { tasks, dismissTask } = useBackgroundTasks();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const t of tasks) {
      if (t.status === 'success') {
        timers.push(setTimeout(() => dismissTask(t.id), 10_000));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [tasks, dismissTask]);

  if (tasks.length === 0) return null;

  const running = tasks.filter(t => t.status === 'running').length;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-elevated border border-border shadow-lg text-xs text-text-primary hover:bg-bg-input transition-colors"
      >
        {running > 0 ? (
          <Loader2 className="w-3 h-3 animate-spin text-accent-magenta" />
        ) : (
          <Check className="w-3 h-3 text-semantic-success" />
        )}
        {tasks.length} task{tasks.length === 1 ? '' : 's'}
        <ChevronUp className="w-3 h-3 text-text-muted" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 space-y-2">
      <div className="flex justify-end mb-1">
        <button
          onClick={() => setCollapsed(true)}
          className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
        >
          <Minimize2 className="w-3 h-3" />
          Minimize
        </button>
      </div>
      {tasks.map(task => (
        <TaskCard key={task.id} task={task} onDismiss={() => dismissTask(task.id)} />
      ))}
    </div>
  );
}

function TaskCard({ task, onDismiss }: { task: BackgroundTask; onDismiss: () => void }) {
  const isRunning = task.status === 'running';
  const isSuccess = task.status === 'success';
  const isError = task.status === 'error';

  return (
    <div className={`rounded-lg border shadow-lg px-3 py-2.5 text-xs animate-in slide-in-from-right-5 ${
      isError
        ? 'bg-semantic-error/10 border-semantic-error/30'
        : 'bg-bg-elevated border-border'
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isRunning && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-magenta shrink-0" />}
          {isSuccess && <Check className="w-3.5 h-3.5 text-semantic-success shrink-0" />}
          {isError && <XIcon className="w-3.5 h-3.5 text-semantic-error shrink-0" />}
          <span className="text-text-primary font-medium truncate">{task.name}</span>
        </div>
        {!isRunning && (
          <button onClick={onDismiss} className="text-text-muted hover:text-text-primary shrink-0">
            <XIcon className="w-3 h-3" />
          </button>
        )}
      </div>
      {isRunning && (
        <div className="mt-1.5 text-text-muted">Working... this may take a few minutes</div>
      )}
      {isSuccess && task.resultText && (
        <div className="mt-1.5 text-semantic-success">{task.resultText}</div>
      )}
      {isError && task.errorText && (
        <div className="mt-1.5 text-semantic-error">{task.errorText}</div>
      )}
    </div>
  );
}
