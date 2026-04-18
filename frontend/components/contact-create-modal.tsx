'use client';

import React from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';

// Matches TRD §3.4 contact_type enum.
const CONTACT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'individual', label: 'Individual' },
  { value: 'family', label: 'Family' },
  { value: 'institutional_investor', label: 'Institutional Investor' },
  { value: 'company', label: 'Company' },
  { value: 'other', label: 'Other' },
];

interface ContactFormState {
  full_name: string;
  email: string;
  phone: string;
  job_title: string;
  contact_type: string;
  linkedin_url: string;
  notes: string;
}

const EMPTY_FORM: ContactFormState = {
  full_name: '',
  email: '',
  phone: '',
  job_title: '',
  contact_type: 'individual',
  linkedin_url: '',
  notes: '',
};

interface ContactCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (contact: { id: string }) => void;
}

export function ContactCreateModal({
  open,
  onClose,
  onCreated,
}: ContactCreateModalProps) {
  const [form, setForm] = React.useState<ContactFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const firstFieldRef = React.useRef<HTMLInputElement>(null);

  // Reset state whenever the modal is (re)opened.
  React.useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
      setSubmitting(false);
      // Focus the name field on the next tick (after the element mounts).
      const t = setTimeout(() => firstFieldRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Escape to dismiss.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const update = <K extends keyof ContactFormState>(k: K, v: ContactFormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.full_name.trim()) {
      setError('Name is required');
      return;
    }
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) {
      setError('Email does not look valid');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, string> = {
        full_name: form.full_name.trim(),
        contact_type: form.contact_type,
      };
      if (form.email.trim()) payload.email = form.email.trim();
      if (form.phone.trim()) payload.phone = form.phone.trim();
      if (form.job_title.trim()) payload.job_title = form.job_title.trim();
      if (form.linkedin_url.trim()) payload.linkedin_url = form.linkedin_url.trim();
      if (form.notes.trim()) payload.notes = form.notes.trim();

      const res = await api.createContact(payload);
      onCreated(res.contact);
    } catch (err: any) {
      setError(err?.message || 'Failed to create contact');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-bg-elevated rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col shadow-2xl border border-border"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Create contact"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div>
            <div className="text-lg font-medium text-text-primary">Add Contact</div>
            <div className="text-xs text-text-muted mt-0.5">
              Manually create a contact. Sync-discovered contacts appear automatically.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-text-muted hover:text-text-primary p-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <Field label="Name" required>
            <input
              ref={firstFieldRef}
              className="input w-full"
              value={form.full_name}
              onChange={e => update('full_name', e.target.value)}
              placeholder="Sarah Chen"
              disabled={submitting}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Email">
              <input
                type="email"
                className="input w-full"
                value={form.email}
                onChange={e => update('email', e.target.value)}
                placeholder="sarah@example.com"
                disabled={submitting}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                className="input w-full"
                value={form.phone}
                onChange={e => update('phone', e.target.value)}
                placeholder="+1 555 123 4567"
                disabled={submitting}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Job Title">
              <input
                className="input w-full"
                value={form.job_title}
                onChange={e => update('job_title', e.target.value)}
                placeholder="Managing Director"
                disabled={submitting}
              />
            </Field>
            <Field label="Type">
              <select
                className="input w-full"
                value={form.contact_type}
                onChange={e => update('contact_type', e.target.value)}
                disabled={submitting}
              >
                {CONTACT_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="LinkedIn URL">
            <input
              type="url"
              className="input w-full"
              value={form.linkedin_url}
              onChange={e => update('linkedin_url', e.target.value)}
              placeholder="https://www.linkedin.com/in/sarahchen"
              disabled={submitting}
            />
          </Field>

          <Field label="Notes">
            <textarea
              className="input w-full min-h-[88px] resize-y"
              value={form.notes}
              onChange={e => update('notes', e.target.value)}
              placeholder="Anything you want to remember about this contact."
              disabled={submitting}
            />
            <div className="text-xs text-text-muted mt-1">
              Saved as the contact&apos;s bio summary.
            </div>
          </Field>

          {error && (
            <div className="card border-l-4 border-semantic-error text-sm text-text-primary">
              {error}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !form.full_name.trim()}
            onClick={handleSubmit}
            className="btn-primary"
          >
            {submitting ? 'Creating…' : 'Create Contact'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">
        {label}
        {required && <span className="text-semantic-error ml-1">*</span>}
      </div>
      {children}
    </label>
  );
}
