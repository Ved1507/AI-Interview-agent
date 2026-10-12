/**
 * Evidence quote checks: a quote is only shown to a reviewer if it appears in the candidate's transcript.
 */

/** Lower-case, drop quote marks and punctuation that vary, collapse whitespace */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[.,;:!?()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimum length keeps a one-word quote from matching by accident */
const MIN_QUOTE_CHARS = 8;

export function quoteAppearsIn(quote: string, transcript: string): boolean {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return false;
  return normalizeForMatch(transcript).includes(needle);
}

export function verifyQuotes(quotes: string[], transcript: string): { kept: string[]; dropped: number } {
  const kept = quotes.filter((q) => quoteAppearsIn(q, transcript));
  return { kept, dropped: quotes.length - kept.length };
}
