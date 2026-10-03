import { describe, expect, it } from 'vitest';

import { sql } from './types.js';

describe('sql() named statements (section 3.2)', () => {
  it('returns a frozen { name, text }', () => {
    const statement = sql('unitSql.selectOne', 'SELECT 1');
    expect(statement).toEqual({ name: 'unitSql.selectOne', text: 'SELECT 1' });
    expect(Object.isFrozen(statement)).toBe(true);
  });

  it('rejects names that are not <module>.<operation>', () => {
    expect(() => sql('selectOne', 'SELECT 1')).toThrow(/<module>\.<operation>/);
    expect(() => sql('unit.select-one', 'SELECT 1')).toThrow(/<module>\.<operation>/);
  });

  it('allows re-declaring a name with the same text (e.g. a module evaluated twice)', () => {
    sql('unitSql.same', 'SELECT 2');
    expect(sql('unitSql.same', 'SELECT 2').text).toBe('SELECT 2');
  });

  it('throws when a name is re-declared with a different text (prepared statement clash)', () => {
    sql('unitSql.clash', 'SELECT 3');
    expect(() => sql('unitSql.clash', 'SELECT 4')).toThrow(
      /already declared with a different statement text/,
    );
  });
});
