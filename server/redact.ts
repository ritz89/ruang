// Secret redaction shared by every reader (logs, task detail, subagent goals). Kept in its own
// module so delegation.ts can redact without importing mission-control.ts (which imports it).

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk|pk|rk|xox[abprs]|ghp|gho|ghs|github_pat|glpat|AKIA)[-_A-Za-z0-9]{8,}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // Values shorter than 8 characters (e.g. `max_tokens: 4096`) are settings, not secrets.
  [/\b([A-Za-z_]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',}]{8,}/gi, '$1$2[redacted]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[redacted]'],
  [/(?:\/home|\/Users)\/[^/\s]+|\/root(?=\/|\b)/g, '~'],
]

export function redactLogLine(line: string, maxLength = 600): string {
  const redacted = SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), line)
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted
}
