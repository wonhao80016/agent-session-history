export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function summarize(text: string, maxChars: number): string {
  return truncate(collapseWhitespace(text), maxChars);
}

/** Joins the text of content blocks whose type is in blockTypes; plain-string content is returned as-is. */
export function extractText(content: unknown, blockTypes: readonly string[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const block of content) {
    if (isObject(block) && typeof block.type === 'string' && blockTypes.includes(block.type) && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Text that CLIs inject into the user role (command echoes, notifications, environment blocks) starts with a tag. */
export function looksInjected(text: string): boolean {
  return /^\s*</.test(text);
}
