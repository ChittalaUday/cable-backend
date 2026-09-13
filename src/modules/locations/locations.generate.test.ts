import { describe, expect, it } from 'vitest';
import { countGenerated, expandLevel, NO_PARENT } from './locations.generate';

describe('bulk generation', () => {
  it('expands literal names under every parent', () => {
    const blocks = [{ name: 'Block A', code: 'A' }, { name: 'Block B', code: 'B' }];

    const floors = expandLevel(blocks, { names: ['Ground', 'First'] });

    expect(floors.map(f => `${f.parentIndex}:${f.name}`))
      .toEqual(['0:Ground', '0:First', '1:Ground', '1:First']);
  });

  it('cascades codes so a door number falls out of its block and floor', () => {
    const blocks = expandLevel([NO_PARENT], { names: ['A', 'B'], nameFormat: 'Block {label}', codeFormat: '{label}' });
    expect(blocks.map(b => [b.name, b.code])).toEqual([['Block A', 'A'], ['Block B', 'B']]);

    const floors = expandLevel(blocks, { count: 2, nameFormat: 'Floor {i}', codeFormat: '{parentCode}{i}' });
    expect(floors.map(f => f.code)).toEqual(['A1', 'A2', 'B1', 'B2']);

    const doors = expandLevel(floors, { count: 3, nameFormat: '{parentCode}{i2}', codeFormat: '{name}' });
    expect(doors.slice(0, 3).map(d => d.name)).toEqual(['A101', 'A102', 'A103']);
    expect(doors.at(-1)?.name).toBe('B203');
  });

  it('honours startAt, for a floor plan that begins at zero', () => {
    const floors = expandLevel([NO_PARENT], { count: 3, nameFormat: 'Floor {i}', startAt: 0 });
    expect(floors.map(f => f.name)).toEqual(['Floor 0', 'Floor 1', 'Floor 2']);
  });

  it('counts the whole cartesian product before anything is written', () => {
    expect(countGenerated([{ count: 3 }, { count: 5 }, { count: 4 }])).toBe(78);
  });
});
