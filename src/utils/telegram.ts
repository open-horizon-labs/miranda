/**
 * Escape Markdown special characters for Telegram's MarkdownV1 parse mode.
 * Characters: _ * ` [ ] ( ) \
 * Use for regular text. For text inside code blocks, use escapeForCodeBlock.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[\]()\\])/g, "\\$1");
}

/**
 * Escape text for use inside Telegram inline code blocks (backticks).
 * Inside code blocks, only backticks need escaping - other chars display literally.
 */
export function escapeForCodeBlock(text: string): string {
  return text.replace(/`/g, "'");
}
