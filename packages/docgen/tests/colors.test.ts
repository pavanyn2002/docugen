import { describe, expect, it } from 'vitest';
import { resolveColorEnabled } from '../src/util/colors.js';

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe('colour detection', () => {
  // Escape codes in a redirected stream corrupt CI logs and any captured file.
  it('is off when the stream is not a TTY', () => {
    expect(resolveColorEnabled({ argv: [], env: {}, stream: pipe })).toBe(false);
  });

  it('is on for an interactive terminal', () => {
    expect(resolveColorEnabled({ argv: [], env: {}, stream: tty })).toBe(true);
  });

  it('honours NO_COLOR over everything else', () => {
    expect(resolveColorEnabled({ argv: ['--color'], env: { NO_COLOR: '1' }, stream: tty })).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(resolveColorEnabled({ argv: [], env: { NO_COLOR: '' }, stream: tty })).toBe(true);
  });

  it('honours --no-color above --color', () => {
    expect(resolveColorEnabled({ argv: ['--no-color', '--color'], env: {}, stream: tty })).toBe(false);
  });

  it('honours FORCE_COLOR for a piped stream', () => {
    expect(resolveColorEnabled({ argv: [], env: { FORCE_COLOR: '1' }, stream: pipe })).toBe(true);
  });

  it('treats FORCE_COLOR=0 as not forcing', () => {
    expect(resolveColorEnabled({ argv: [], env: { FORCE_COLOR: '0' }, stream: pipe })).toBe(false);
  });

  it('is off for a dumb terminal', () => {
    expect(resolveColorEnabled({ argv: [], env: { TERM: 'dumb' }, stream: tty })).toBe(false);
  });
});
