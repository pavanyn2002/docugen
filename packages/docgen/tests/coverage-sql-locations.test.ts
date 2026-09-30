import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/extract/schema/sql-ddl.js';

describe('SQL citation line tracking', () => {
  it('cites the first SQL token after comments and whitespace rather than the previous separator', () => {
    expect(splitStatements("; -- note\n/* note */\n$body$ select ';'; $body$;\nCREATE TABLE users (id int);\nSELECT 1"))
      .toEqual([
        { text: "$body$ select ';'; $body$", line: 3 },
        { text: 'CREATE TABLE users (id int)', line: 4 },
        { text: 'SELECT 1', line: 5 },
      ]);
  });
});
