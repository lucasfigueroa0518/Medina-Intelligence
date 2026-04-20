'use client';

import React from 'react';
import { useRouter } from 'next/navigation';

export function SessionExpiredBanner() {
  const router = useRouter();
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('auth:session-expired', handler);
    return () => window.removeEventListener('auth:session-expired', handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-bg-elevated border-l-4 border-semantic-error rounded-xl shadow-lg px-5 py-3 flex items-center gap-4">
      <div>
        <div className="text-sm font-medium text-text-primary">Session expired</div>
        <div className="text-xs text-text-secondary mt-0.5">
          Your session has expired. Please sign in again.
        </div>
      </div>
      <button
        onClick={() => {
          setVisible(false);
          router.push('/login');
        }}
        className="btn-secondary text-xs py-1.5"
      >
        Sign In
      </button>
    </div>
  );
}
