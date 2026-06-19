export function withTrailingNewline(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) {
    return text;
  }
  return `${text}\n`;
}

export function joinOutputLines(lines: string[]): string {
  return withTrailingNewline(lines.join("\n"));
}
