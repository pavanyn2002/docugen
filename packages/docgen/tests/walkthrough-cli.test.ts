import { describe, expect, it } from 'vitest';
import { buildCli } from '../src/cli.js';

describe('screenshot walkthrough CLI', () => {
  it('offers importing, browser capture, inspection, and explicit human review', () => {
    const walkthrough = buildCli().commands.find((command) => command.name() === 'walkthrough');
    expect(walkthrough?.commands.map((command) => command.name()).sort()).toEqual([
      'capture', 'import', 'list', 'review', 'show',
    ]);
  });
});
