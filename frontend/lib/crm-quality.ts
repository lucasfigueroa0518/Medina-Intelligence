export type CrmQualityCustomFields = string | Record<string, any> | null | undefined;

export function parseCustomFields(raw: CrmQualityCustomFields): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function crmQualityNameStatus(raw: CrmQualityCustomFields): string | null {
  const fields = parseCustomFields(raw);
  return typeof fields.crm_quality?.name_status === 'string'
    ? fields.crm_quality.name_status
    : null;
}

export function tentativeNameLabel(raw: CrmQualityCustomFields): string | null {
  const status = crmQualityNameStatus(raw);
  if (status === 'provisional' || status === 'domain_placeholder') return 'Tentative name';
  return null;
}
