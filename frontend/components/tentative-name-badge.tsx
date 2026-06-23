'use client';

import { AlertCircle } from 'lucide-react';
import { tentativeNameLabel, type CrmQualityCustomFields } from '@/lib/crm-quality';

export function TentativeNameBadge({
  customFields,
  className = '',
}: {
  customFields: CrmQualityCustomFields;
  className?: string;
}) {
  const label = tentativeNameLabel(customFields);
  if (!label) return null;

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-200 ${className}`}
      title="Name is based on limited source evidence and will be reviewed when stronger evidence arrives."
    >
      <AlertCircle size={11} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
