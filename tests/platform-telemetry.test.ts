import { describe, expect, it } from 'vitest';
import { __platformTelemetryTestHooks } from '../src/lib/platform-telemetry';

describe('platform telemetry routing helpers', () => {
  it('classifies ingestion/backfill questions as user ingestion telemetry', () => {
    expect(__platformTelemetryTestHooks.inferPlatformTelemetryTopic({
      query: 'how many emails has raul ingested into the platform? has he run a backfill?',
      topic: 'auto',
    })).toBe('user_ingestion');
  });

  it('classifies embedding coverage questions as data coverage telemetry', () => {
    expect(__platformTelemetryTestHooks.inferPlatformTelemetryTopic({
      query: 'check whether document embedding coverage is working',
      topic: 'auto',
    })).toBe('data_coverage');
  });

  it('classifies enrichment, news, and Gemini cadence questions as pipeline telemetry', () => {
    expect(__platformTelemetryTestHooks.inferPlatformTelemetryTopic({
      query: 'how often is company enrichment happening? the news? How consistently are we calling gemini?',
      topic: 'auto',
    })).toBe('pipeline_health');
  });

  it('resolves a named user from first-name platform questions', () => {
    const candidate = __platformTelemetryTestHooks.scoreTelemetryUserCandidate(
      'How many emails has Raul ingested?',
      {
        id: 'user-raul',
        email: 'raul@medinacapital.com',
        full_name: 'Raul Medina',
      }
    );

    expect(candidate.score).toBeGreaterThanOrEqual(75);
    expect(candidate.reasons).toContain('first_name_match');
  });
});
