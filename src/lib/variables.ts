// TRD §12.1 — Campaign merge variables
export interface CampaignRecipientVars {
  full_name: string;
  job_title?: string;
  company_name?: string;
  custom_fields?: string; // JSON
}

export function resolveVariables(
  template: string,
  contact: CampaignRecipientVars
): string {
  let custom: Record<string, string> = {};
  try {
    custom = JSON.parse(contact.custom_fields || '{}');
  } catch {
    custom = {};
  }

  return template
    .replace(/\{\{full_name\}\}/g, contact.full_name || '')
    .replace(/\{\{first_name\}\}/g, (contact.full_name || '').split(' ')[0])
    .replace(/\{\{company_name\}\}/g, contact.company_name || '')
    .replace(/\{\{job_title\}\}/g, contact.job_title || '')
    .replace(/\{\{custom\.(\w+)\}\}/g, (_: string, field: string) => custom[field] || '');
}
