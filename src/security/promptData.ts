/**
 * Shared rules for putting candidate-supplied text into LLM prompts.
 * The CV and the answers are untrusted data: they are wrapped in tags, and the model is told not to follow them.
 */

/** The CV passed to any model call. Scoring and the report both use this limit. */
export const CV_MODEL_CHARS = 20000;

export function cvForModel(text: string): { text: string; truncated: boolean } {
  if (text.length <= CV_MODEL_CHARS) return { text, truncated: false };
  return { text: text.slice(0, CV_MODEL_CHARS), truncated: true };
}

/**
 * Wrap untrusted text in a data block. A closing tag inside the text is neutralized,
 * so the text cannot end the block early and pose as instructions.
 */
export function asDataBlock(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`</?\\s*${tag}\\s*>`, 'gi'), `[${tag} tag removed]`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
