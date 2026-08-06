/** Converts LF or CRLF text to the terminal's single CRLF convention. */
export function normalizeTerminalNewlines(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}
