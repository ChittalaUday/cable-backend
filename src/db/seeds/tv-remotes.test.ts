import fs from 'node:fs';
import path from 'node:path';
import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { RemoteButtonSchema } from '@/types/remotes';

const library = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'data/tv-remotes.json'), 'utf8'),
) as { brand: string; model: string; buttons: { key: string; command: unknown }[] }[];

describe('flipper-irdb tv library', () => {
  it('is non-empty', () => {
    expect(library.length).toBeGreaterThan(20);
  });

  it('holds only commands the emitter can encode', () => {
    const invalid = library.flatMap(remote =>
      remote.buttons.filter(button => !Check(RemoteButtonSchema, button)).map(button => `${remote.brand} ${remote.model} ${button.key}`),
    );
    expect(invalid).toEqual([]);
  });

  it('has one row per brand and model, so the seed upsert can key on it', () => {
    const keys = library.map(remote => `${remote.brand}|${remote.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every remote can switch the set on', () => {
    const powerless = library
      .filter(remote => !remote.buttons.some(button => button.key === 'power'))
      .map(remote => `${remote.brand} ${remote.model}`);
    expect(powerless).toEqual(['Universal Power off blaster (all brands)']);
  });

  it('decodes the protocols the way the hand-written entries do', () => {
    const power = (brand: string) =>
      library.find(remote => remote.brand === brand)?.buttons.find(button => button.key === 'power')?.command;

    expect(power('Samsung')).toEqual({ protocol: 'samsung', address: 0x0707, command: 0x02 });
    expect(power('LG')).toEqual({ protocol: 'nec', address: 0x04, command: 0x08 });
    expect(power('Sony')).toEqual({ protocol: 'sony-sirc', bits: 12, data: 0x95, repeatCount: 2 });
  });
});
