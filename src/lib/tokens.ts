// TRD §18.1 — Token estimation + truncation

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  const truncated = text.substring(0, maxChars);
  const lastSentence = truncated.lastIndexOf('. ');
  return lastSentence > maxChars * 0.7 ? truncated.substring(0, lastSentence + 1) : truncated;
}
