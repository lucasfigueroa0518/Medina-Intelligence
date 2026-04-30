// Wave 5 Phase B — junk-mime + junk-filename denylist for document ingestion.
//
// What this catches: calendar invites (.ics), email-signature artifacts
// (image/*, multipart/signed, S/MIME-protected wrappers), inline branding
// imagery, video/audio attachments that aren't documents, and Outlook's
// "unavailable" placeholder for attachments that never resolved.
//
// What it does NOT catch: ordinary attachments that happen to be junk
// (e.g. a vendor logo embedded in a contract — that's already covered by
// the document being a real PDF). Filename pattern matching is deliberately
// conservative — only well-known artifacts, no keyword guessing.
//
// Caller behavior on a denylist hit (`isDenylisted(...).excluded === true`):
//   - skip the binary fetch (no R2 put, no Graph $value GET)
//   - write a documents row with `processing_status='excluded'`,
//     `r2_key=''`, and the returned `reason` in `error_message`
//   - still write document_links so entity views can show "we got 12
//     attachments on this thread, here's the breakdown"
// This mirrors the oversize-skip pattern at attachment-processor.ts:76-109.

const JUNK_MIMES_EXACT = new Set<string>([
  'text/calendar',
  'application/ics',
  'multipart/signed',
  'application/x-microsoft-rpmsg-message',
  'application/pkcs7-signature',
  'application/x-pkcs7-signature',
]);

const JUNK_MIME_PREFIXES: ReadonlyArray<string> = ['image/', 'video/', 'audio/'];

const JUNK_FILENAME_EXACT = new Set<string>(['unavailable']);

export function isDenylisted(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): { excluded: boolean; reason?: string } {
  const m = (mimeType || '').toLowerCase();
  const f = (fileName || '').toLowerCase();

  if (m && JUNK_MIMES_EXACT.has(m)) {
    return { excluded: true, reason: `denylisted mime: ${m}` };
  }
  if (m) {
    for (const prefix of JUNK_MIME_PREFIXES) {
      if (m.startsWith(prefix)) {
        return { excluded: true, reason: `denylisted mime prefix: ${prefix}*` };
      }
    }
  }
  if (f && JUNK_FILENAME_EXACT.has(f)) {
    return { excluded: true, reason: `denylisted filename: ${f}` };
  }

  return { excluded: false };
}
