// Name quality validation + normalization for discovered contacts.
// Used to reject garbage names like "noreply", "calendar", "f1", "g1" before
// inserting a contact row.

const AUTOMATED_LOCAL_RE = /^(calendar|invite|invites|notification|notifications|noreply|no-reply|info|support|help|admin|administrator|billing|news|newsletter|newsletters|updates|team|hello|contact|sales|marketing|accounts|payments|registration|system|mailer|daemon|postmaster|do-not-reply|donotreply|alerts|notice|notify|webmaster|abuse|security|hr|jobs|careers|press|media|legal|privacy|reply|replies|service|services|email|mail)$/i;

export function isValidContactName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;

  // All-lowercase single-word things ("noreply", "info") are not real names.
  if (trimmed === trimmed.toLowerCase() && !trimmed.includes(' ')) return false;

  // Two-letter or shorter alphanumerics ("f1", "g1", "x")
  if (/^\w{1,2}$/.test(trimmed)) return false;

  // Contains a 3+ digit run — IDs, codes, "Order #12345"
  if (/\d{3,}/.test(trimmed)) return false;

  // Common automated/shared mailbox aliases
  if (AUTOMATED_LOCAL_RE.test(trimmed)) return false;

  // No spaces and unusually long — almost certainly not a real name
  if (!trimmed.includes(' ') && trimmed.length > 15) return false;

  return true;
}

export function toTitleCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map(word => {
      if (word.length === 0) return word;
      // Preserve all-caps abbreviations of length <= 3 (e.g. "III", "MD")
      if (word.length <= 3 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// Try to extract a usable display name from {fromEmail, fromName, recipientNames}
// for a given target email. Returns null when nothing valid is found.
export function resolveContactName(
  email: string,
  fromEmail: string | undefined,
  fromName: string | undefined,
  recipientNames: Record<string, string> | undefined
): string | null {
  const lower = email.toLowerCase();

  // 1. fromEmail matches and fromName is real
  if (fromEmail && fromEmail.toLowerCase() === lower && fromName) {
    const candidate = toTitleCase(fromName);
    if (isValidContactName(candidate)) return candidate;
  }

  // 2. recipientNames has an entry for this email
  if (recipientNames) {
    const direct = recipientNames[lower] || recipientNames[email];
    if (direct) {
      const candidate = toTitleCase(direct);
      if (isValidContactName(candidate)) return candidate;
    }
  }

  // 3. No usable name — caller must decide whether to skip or queue.
  return null;
}
