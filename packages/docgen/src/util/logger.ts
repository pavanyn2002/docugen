import { colors } from './colors.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** Section heading in the run report. */
  heading(message: string): void;
  /** Machine-readable output (JSON). Always written to stdout regardless of level. */
  output(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Diagnostics stream. Defaults to stderr so `--json` stdout stays parseable. */
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const rank = LEVEL_RANK[level];
  const err = options.stderr ?? process.stderr;
  const out = options.stdout ?? process.stdout;

  const write = (stream: NodeJS.WritableStream, message: string): void => {
    stream.write(`${message}\n`);
  };

  return {
    level,
    error: (m) => rank >= LEVEL_RANK.error && write(err, `${colors().red('error')} ${m}`),
    warn: (m) => rank >= LEVEL_RANK.warn && write(err, `${colors().yellow('warn')}  ${m}`),
    info: (m) => rank >= LEVEL_RANK.info && write(err, m),
    debug: (m) => rank >= LEVEL_RANK.debug && write(err, `${colors().dim('debug')} ${colors().dim(m)}`),
    heading: (m) => rank >= LEVEL_RANK.info && write(err, `\n${colors().bold(m)}`),
    output: (m) => write(out, m),
  };
}
