import { describe, expect, it } from 'vitest';
import { __firmRelationshipStateTestHooks } from '../src/lib/firm-relationship-state';

const {
  classifyFirmRelationship,
  isFoundationalPortfolioCompanyName,
  isOpenDealStage,
  normalizeCompanyNameKey,
} = __firmRelationshipStateTestHooks;

describe('firm relationship state classification', () => {
  it('treats active current_portfolio relationship rows as authoritative', () => {
    const result = classifyFirmRelationship({
      name: 'NeuralSeek',
      company_type: 'startup',
      investment_status: 'tracking',
      relationship_states: ['current_portfolio'],
      authoritative_current_portfolio_active: true,
    });

    expect(result.state).toBe('current_portfolio');
    expect(result.confidence).toBe('authoritative');
  });

  it('does not let CRM portfolio tags override the authoritative current portfolio allowlist', () => {
    const result = classifyFirmRelationship({
      name: 'Insigneo',
      company_type: 'portfolio',
      investment_status: 'tracking',
      tags: ['Portfolio'],
      relationship_states: [],
      authoritative_current_portfolio_active: true,
    });

    expect(result.state).not.toBe('current_portfolio');
    expect(result.warnings.join(' ')).toMatch(/authoritative firm relationship/i);
  });

  it('separates active pipeline from current portfolio', () => {
    const result = classifyFirmRelationship({
      name: 'FluentReach',
      investment_status: 'due_diligence',
      active_deal_count: 1,
      active_deals: ['FluentReach Seed (due_diligence)'],
      relationship_states: [],
      authoritative_current_portfolio_active: true,
    });

    expect(result.state).toBe('active_pipeline');
    expect(result.reasons.join(' ')).toMatch(/active deal/i);
  });

  it('uses the current closed stage as non-active while tolerating legacy values', () => {
    expect(isOpenDealStage('new')).toBe(true);
    expect(isOpenDealStage('talking')).toBe(true);
    expect(isOpenDealStage('closed')).toBe(false);
    expect(isOpenDealStage('closed_won')).toBe(false);
    expect(isOpenDealStage('closed_lost')).toBe(false);
  });

  it('recognizes foundational portfolio aliases including Hedgehog variants', () => {
    expect(normalizeCompanyNameKey('Neural Seek, Inc.')).toBe('neuralseekinc');
    expect(isFoundationalPortfolioCompanyName('Hedgehog')).toBe(true);
    expect(isFoundationalPortfolioCompanyName('Hedgehog AI')).toBe(true);
    expect(isFoundationalPortfolioCompanyName('Tier 4 AI')).toBe(true);
    expect(isFoundationalPortfolioCompanyName('QNECT')).toBe(true);
    expect(isFoundationalPortfolioCompanyName('Neural Seek')).toBe(true);
    expect(isFoundationalPortfolioCompanyName('Insigneo')).toBe(false);
  });
});
