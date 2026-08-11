export interface RedactionResult {
  readonly text: string;
  readonly count: number;
  readonly kinds: readonly string[];
}

interface Rule {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly replace: string | ((substring: string, ...args: string[]) => string);
}

const rules: readonly Rule[] = [
  { kind: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, replace: '[REDACTED:private-key]' },
  { kind: 'url-credential', pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, replace: (_match, prefix, suffix) => `${prefix}[REDACTED:url-credential]${suffix}` },
  { kind: 'named-secret', pattern: /(\b(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*)(["'`])([^\r\n"'`]+)\2/gi, replace: (_match, prefix, quote) => `${prefix}${quote}[REDACTED:named-secret]${quote}` },
  { kind: 'named-secret', pattern: /(\b(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*)(?!["'`\[])([^\s,;}\]]{6,})/gi, replace: (_match, prefix) => `${prefix}[REDACTED:named-secret]` },
  { kind: 'known-token', pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g, replace: '[REDACTED:known-token]' },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[REDACTED:jwt]' },
];

/** Deterministically remove common credential forms before model context is built. */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const matched = args[0] as string;
      if (matched.includes('[REDACTED:')) return matched;
      count += 1;
      kinds.add(rule.kind);
      if (typeof rule.replace === 'string') return rule.replace;
      return rule.replace(matched, ...(args.slice(1, -2) as string[]));
    });
  }
  return { text, count, kinds: [...kinds].sort() };
}
