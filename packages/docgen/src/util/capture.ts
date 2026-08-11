import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { Writable } from 'node:stream';

class StringSink extends Writable {
  private value = '';

  override _write(chunk: Uint8Array | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    callback();
  }

  text(): string { return this.value.trim(); }
}

/** Capture one command's JSON result without allowing diagnostics onto a protocol stream. */
export async function captureJson(run: (logger: Logger) => Promise<void>): Promise<unknown> {
  const stdout = new StringSink();
  const stderr = new StringSink();
  await run(createLogger({ level: 'silent', stdout, stderr }));
  const value = stdout.text();
  return value.length === 0 ? null : JSON.parse(value) as unknown;
}
