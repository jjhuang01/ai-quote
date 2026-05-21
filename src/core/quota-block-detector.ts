import type { QuotaBlockDetection } from './contracts';

/**
 * Detect quota/rate limit blocks from Cascade response text
 */
export class QuotaBlockDetector {
  private static readonly PATTERNS = {
    quotaExhausted: [
      /included daily usage quota is exhausted/i,
      /included usage quota is exhausted/i,
      /daily usage quota is exhausted/i,
      /usage quota is exhausted/i,
      /purchase extra usage to continue/i,
      /exceeded your current quota/i,
      /quota exceeded/i,
    ],
    rateLimitShort: [
      /rate limit.*retry-after:\s*(\d+s?)\b/i,
      /too many requests.*retry-after:\s*(\d+s?)\b/i,
      /permission denied:\s*all api providers are over their global/i,
    ],
    rateLimitLong: [
      /rate limit.*retry-after:\s*(\d+[hm])/i,
      /too many requests.*retry-after:\s*(\d+[hm])/i,
    ],
  };

  /**
   * Detect quota block type from response text
   */
  static detect(text: string): QuotaBlockDetection {
    // Check quota exhausted first (highest priority)
    for (const pattern of this.PATTERNS.quotaExhausted) {
      const match = text.match(pattern);
      if (match) {
        const resetAt = this.parseResetAt(text);
        return {
          type: 'quota_exhausted',
          matchedText: match[0],
          resetAt,
        };
      }
    }

    // Check short rate limit
    for (const pattern of this.PATTERNS.rateLimitShort) {
      const match = text.match(pattern);
      if (match) {
        return {
          type: 'rate_limited_short',
          matchedText: match[0],
          retryDelayMs: match[1] ? this.parseRetryDelay(match[1]) : undefined,
        };
      }
    }

    // Check long rate limit
    for (const pattern of this.PATTERNS.rateLimitLong) {
      const match = text.match(pattern);
      if (match) {
        const resetAt = this.parseResetAt(text);
        return {
          type: 'rate_limited_long',
          matchedText: match[0],
          resetAt,
        };
      }
    }

    return {
      type: 'none',
      matchedText: '',
    };
  }

  /**
   * Parse reset time from text (e.g., "Quota resets 5月22日 GMT+8 16:00")
   */
  private static parseResetAt(text: string): string | undefined {
    // Try Chinese date format: "5月22日 GMT+8 16:00"
    const cnDateMatch = text.match(/(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{2})/);
    if (cnDateMatch) {
      const [, month, day, hour, minute] = cnDateMatch;
      const now = new Date();
      const year = now.getFullYear();
      const resetDate = new Date(`${year}-${month}-${day} ${hour}:${minute}:00`);
      return resetDate.toISOString();
    }

    // Try ISO format or other common formats
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (isoMatch) {
      return isoMatch[1];
    }

    return undefined;
  }

  /**
   * Parse retry delay (e.g., "42s" -> 42000ms)
   */
  private static parseRetryDelay(delayStr: string): number | undefined {
    const match = delayStr.match(/(\d+)/);
    if (!match) return undefined;
    const value = parseInt(match[1], 10);
    
    if (/^\d+$/.test(delayStr) || delayStr.includes('s')) return value * 1000;
    if (delayStr.includes('m')) return value * 60 * 1000;
    if (delayStr.includes('h')) return value * 60 * 60 * 1000;
    
    return undefined;
  }

  /**
   * Extract trajectory ID from transcript path
   */
  static extractTrajectoryId(transcriptPath?: string): string | undefined {
    if (!transcriptPath) return undefined;
    const match = transcriptPath.match(/\/transcripts\/([^/.]+)\.jsonl/);
    return match?.[1];
  }
}
