// TRD §16.7
export const IMPORT_COLUMN_MAPPING_PROMPT = `You are helping map CSV/spreadsheet columns to a CRM contact schema. Given the column headers and sample data, suggest the best mapping.

Target fields: full_name, email, phone, company_name, job_title, contact_type (individual/family/institutional_investor/company/other), relationship_status (lp/portfolio_founder/prospect/advisor/vendor/other), linkedin_url, investment_amount, fund_commitment, notes

Return a JSON object mapping source columns to target fields. Use null for columns that don't map to any field. If a source column could map to multiple fields, choose the most likely one.

Example: {"Name": "full_name", "Email Address": "email", "Company": "company_name", "Random Notes": "notes", "ID Number": null}`;
