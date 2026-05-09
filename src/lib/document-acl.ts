// Document-level ACL gate. Mirrors postRetrievalFilter in src/lib/retrieval.ts
// for the documents domain so that /api/documents listings, single-doc fetches,
// and downloads enforce the same visibility rules the RAG layer applies to
// document chunks. Without this, a non-owner calling GET /api/documents would
// see every row in the org while the same user's MARTy queries would correctly
// hide private rows — a privacy bug, not just an inconsistency.
import { hasOrgWidePrivateDataAccess, parseParticipantUserIds } from './helpers';

export interface DocumentAclFields {
  visibility?: string | null;
  participant_user_ids?: string | null;
  uploaded_by?: string | null;
}

export function isDocumentAccessibleToUser(
  doc: DocumentAclFields,
  userId: string,
  userRole: string,
  sharingSet?: Set<string>
): boolean {
  if (hasOrgWidePrivateDataAccess(userRole)) return true;

  const visibility = doc.visibility;
  // Default-deny on missing visibility — matches retrieval.ts:198-205. A row
  // missing the field is data we can't classify; treating it as accessible
  // would leak any future row that lands without the column populated.
  if (!visibility) return false;

  if (visibility === 'private') {
    if (doc.uploaded_by && doc.uploaded_by === userId) return true;
    const participants = parseParticipantUserIds(doc.participant_user_ids);
    if (participants.includes(userId)) return true;
    if (sharingSet && participants.some(p => sharingSet.has(p))) return true;
    return false;
  }

  if (visibility === 'confidential') {
    return userRole === 'admin';
  }

  if (visibility === 'org_wide' || visibility === 'public' || visibility === 'org') {
    return true;
  }

  // Unknown value — deny. Logged at the caller site so we can spot drift.
  return false;
}
