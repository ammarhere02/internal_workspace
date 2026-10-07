/** Strip credentials from a connection string or error message before it reaches a log or HTTP response. */
export function redactSecrets(text: string): string {
  return text.replace(/\/\/([^:/@\s]+):([^@\s]+)@/g, '//$1:[redacted]@');
}
