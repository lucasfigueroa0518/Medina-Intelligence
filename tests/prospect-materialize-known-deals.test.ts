import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { materializeKnownDeals } from '../scripts/prospect-materialize-known-deals';

class Statement {
  private binds: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): Statement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.first(this.sql, this.binds) as T | null;
  }

  async run(): Promise<void> {
    this.db.run(this.sql, this.binds);
  }
}

class FakeD1 {
  companies: any[] = [];
  deals: any[] = [];
  prospects: any[] = [];

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/FROM deals d\s+LEFT JOIN companies c/i.test(sql)) {
      const [orgId, limit] = binds;
      return this.deals
        .filter(deal => deal.org_id === orgId && !deal.deleted_at && deal.stage !== 'closed')
        .slice(0, Number(limit || 10_000))
        .map(deal => {
          const company = this.companies.find(row => row.id === deal.company_id && row.org_id === deal.org_id && !row.deleted_at);
          const prospect = this.prospects.find(row => row.org_id === deal.org_id && row.deal_id === deal.id && !row.deleted_at);
          return {
            deal_id: deal.id,
            company_id: deal.company_id || null,
            company_name: company?.name || null,
            existing_prospect_id: prospect?.id || null,
          };
        });
    }
    return [];
  }

  first(sql: string, binds: unknown[]): any | null {
    if (/FROM deals d\s+JOIN companies c/i.test(sql)) {
      const [orgId, dealId] = binds;
      const deal = this.deals.find(row => row.org_id === orgId && row.id === dealId && !row.deleted_at && row.stage !== 'closed');
      if (!deal) return null;
      const company = this.companies.find(row => row.org_id === orgId && row.id === deal.company_id && !row.deleted_at);
      if (!company) return null;
      return {
        deal_id: deal.id,
        company_id: deal.company_id,
        created_at: deal.created_at || null,
        updated_at: deal.updated_at || null,
        company_name: company.name,
        company_domain: company.domain || null,
        company_website: company.website || null,
        company_sector: company.sector || null,
      };
    }
    if (/FROM prospects/i.test(sql) && /deal_id = \?/i.test(sql)) {
      const [orgId, dealId] = binds;
      const row = this.prospects.find(entry => entry.org_id === orgId && entry.deal_id === dealId && !entry.deleted_at);
      return row ? { id: row.id } : null;
    }
    if (/FROM prospects/i.test(sql) && /normalized_name = \?/i.test(sql)) {
      const [orgId, normalizedName] = binds;
      const row = this.prospects.find(entry => entry.org_id === orgId && entry.normalized_name === normalizedName && !entry.deleted_at);
      return row ? { id: row.id } : null;
    }
    return null;
  }

  run(sql: string, binds: unknown[]): void {
    if (/UPDATE prospects/i.test(sql) && /status = 'converted'/i.test(sql)) {
      const prospectId = binds[13];
      const orgId = binds[14];
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row) {
        row.status = 'converted';
        row.signal_strength = Math.max(Number(row.signal_strength || 0), 85);
      }
      return;
    }
    if (/INSERT INTO prospects/i.test(sql) && /company_id, deal_id/i.test(sql)) {
      const normalizedName = binds[3];
      const existing = this.prospects.find(row => row.org_id === binds[1] && row.normalized_name === normalizedName);
      if (existing) {
        existing.company_id = existing.company_id || binds[5];
        existing.deal_id = existing.deal_id || binds[6];
        existing.status = 'converted';
        existing.signal_strength = Math.max(Number(existing.signal_strength || 0), 85);
        return;
      }
      this.prospects.push({
        id: binds[0],
        org_id: binds[1],
        canonical_name: binds[2],
        normalized_name: normalizedName,
        domain: binds[4],
        company_id: binds[5],
        deal_id: binds[6],
        status: 'converted',
        signal_strength: 85,
      });
    }
  }
}

describe('prospect known-deal materialization script', () => {
  it('keeps CLI apply mode behind an explicit production-write confirmation', () => {
    const source = readFileSync('scripts/prospect-materialize-known-deals.ts', 'utf8');

    expect(source).toContain('confirm-production-write');
    expect(source).toContain('APPLY_REQUIRES_EXPLICIT_GO');
  });

  it('dry-runs without writing and reports create/update/already-linked actions', async () => {
    const db = new FakeD1();
    db.companies.push(
      { id: 'company-alpha', org_id: 'org-1', name: 'Alpha Labs', domain: 'alpha.test' },
      { id: 'company-beta', org_id: 'org-1', name: 'Beta Systems', domain: 'beta.test' },
      { id: 'company-gamma', org_id: 'org-1', name: 'Gamma AI', domain: 'gamma.test' },
    );
    db.deals.push(
      { id: 'deal-alpha', org_id: 'org-1', company_id: 'company-alpha', stage: 'talking' },
      { id: 'deal-beta', org_id: 'org-1', company_id: 'company-beta', stage: 'prospect' },
      { id: 'deal-gamma', org_id: 'org-1', company_id: 'company-gamma', stage: 'diligence' },
      { id: 'deal-orphan', org_id: 'org-1', company_id: 'company-missing', stage: 'talking' },
    );
    db.prospects.push(
      { id: 'prospect-beta', org_id: 'org-1', normalized_name: 'betasystems', deal_id: 'deal-beta', status: 'converted' },
      { id: 'prospect-gamma', org_id: 'org-1', normalized_name: 'gamma', status: 'active' },
    );

    const summary = await materializeKnownDeals('org-1', { D1: db } as any, { apply: false });

    expect(summary).toMatchObject({
      dry_run: true,
      scanned: 4,
      created: 1,
      updated: 1,
      already_linked: 1,
      skipped_no_company: 1,
    });
    expect(db.prospects).toHaveLength(2);
  });

  it('apply mode creates missing backlinks and skips already-linked deals', async () => {
    const db = new FakeD1();
    db.companies.push(
      { id: 'company-alpha', org_id: 'org-1', name: 'Alpha Labs', domain: 'alpha.test', sector: 'ai_data' },
      { id: 'company-beta', org_id: 'org-1', name: 'Beta Systems', domain: 'beta.test' },
    );
    db.deals.push(
      { id: 'deal-alpha', org_id: 'org-1', company_id: 'company-alpha', stage: 'talking' },
      { id: 'deal-beta', org_id: 'org-1', company_id: 'company-beta', stage: 'prospect' },
    );
    db.prospects.push({ id: 'prospect-beta', org_id: 'org-1', normalized_name: 'betasystems', deal_id: 'deal-beta', status: 'converted' });

    const summary = await materializeKnownDeals('org-1', { D1: db } as any, { apply: true });

    expect(summary).toMatchObject({
      dry_run: false,
      scanned: 2,
      created: 1,
      already_linked: 1,
      conflicts: [],
    });
    expect(db.prospects).toHaveLength(2);
    expect(db.prospects.find(row => row.deal_id === 'deal-alpha')).toMatchObject({
      canonical_name: 'Alpha Labs',
      company_id: 'company-alpha',
      status: 'converted',
      signal_strength: 85,
    });
  });
});
