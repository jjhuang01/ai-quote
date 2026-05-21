import { describe, expect, it } from 'vitest';
import { QuotaBlockDetector } from '../../src/core/quota-block-detector';

describe('QuotaBlockDetector', () => {
  it('detects hard quota exhaustion from Windsurf message', () => {
    const detection = QuotaBlockDetector.detect(
      'Your included usage quota is exhausted. Purchase extra usage to continue using premium models. Quota resets 5月22日 GMT+8 16:00.',
    );

    expect(detection.type).toBe('quota_exhausted');
    expect(detection.matchedText).toMatch(/included usage quota is exhausted/i);
    expect(detection.resetAt).toBeDefined();
  });

  it('detects global provider permission limit as short rate limit', () => {
    const detection = QuotaBlockDetector.detect(
      'Permission denied: all API providers are over their global rate limit. Please retry later.',
    );

    expect(detection.type).toBe('rate_limited_short');
    expect(detection.matchedText).toMatch(/permission denied/i);
  });

  it('parses retry-after seconds as short rate limit', () => {
    const detection = QuotaBlockDetector.detect('Too many requests. retry-after: 42s');

    expect(detection.type).toBe('rate_limited_short');
    expect(detection.retryDelayMs).toBe(42_000);
  });

  it('parses retry-after minutes as long rate limit', () => {
    const detection = QuotaBlockDetector.detect('Rate limit reached. retry-after: 15m');

    expect(detection.type).toBe('rate_limited_long');
  });

  it('returns none for unrelated text', () => {
    const detection = QuotaBlockDetector.detect('The file has been created successfully.');

    expect(detection.type).toBe('none');
  });

  it('extracts trajectory id from transcript path', () => {
    expect(
      QuotaBlockDetector.extractTrajectoryId('/Users/me/.windsurf/transcripts/abc123.jsonl'),
    ).toBe('abc123');
  });
});
