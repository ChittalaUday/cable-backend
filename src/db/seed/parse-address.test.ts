import { describe, expect, it } from 'vitest';
import { parseAddress } from './parse-address';

/**
 * Every string here is copied verbatim out of the MSO report — the point of the
 * parser is the mess, so inventing tidier inputs would test nothing.
 */
describe('parseAddress', () => {
  it('reads the glued form the report mostly uses', () => {
    expect(parseAddress('A31sf1')).toEqual({ kind: 'door', group: 'A', apartment: 'A31', floor: 'SF', door: 1 });
    expect(parseAddress('C13gf6')).toEqual({ kind: 'door', group: 'C', apartment: 'C13', floor: 'GF', door: 6 });
  });

  it.each([
    { raw: 'A38 GF 4', apartment: 'A38', floor: 'GF', door: 4 },
    { raw: 'A11. Sf7', apartment: 'A11', floor: 'SF', door: 7 },
    { raw: 'a43 sf8', apartment: 'A43', floor: 'SF', door: 8 },
    { raw: 'A50     Tf7', apartment: 'A50', floor: 'TF', door: 7 },
    { raw: 'C15 TF,7', apartment: 'C15', floor: 'TF', door: 7 },
    { raw: 'C-66, GF4, TIDCO House, Gollapuntha Colony, Mandapeta', apartment: 'C66', floor: 'GF', door: 4 },
    { raw: 'TIDCO C53 SF 3', apartment: 'C53', floor: 'SF', door: 3 },
    { raw: 'Address TDICO A38. Sf1', apartment: 'A38', floor: 'SF', door: 1 },
    { raw: 'TIDCO PLOT NO C41 FF3', apartment: 'C41', floor: 'FF', door: 3 },
    { raw: 'TITCO  c48 ff3', apartment: 'C48', floor: 'FF', door: 3 },
    { raw: 'A28, FF6, TIDCO HOUSES', apartment: 'A28', floor: 'FF', door: 6 },
    { raw: 'A52 sf7 70532979690', apartment: 'A52', floor: 'SF', door: 7 },
  ])('places $raw at $apartment $floor$door whatever the spacing and trailing noise', ({ raw, ...expected }) => {
    expect(parseAddress(raw)).toMatchObject({ kind: 'door', ...expected });
  });

  it('keeps double-digit doors — some blocks really do run past 8', () => {
    expect(parseAddress('A57  GF 10 TIDCO HOUSES')).toMatchObject({ apartment: 'A57', floor: 'GF', door: 10 });
    expect(parseAddress('A51ff11')).toMatchObject({ apartment: 'A51', floor: 'FF', door: 11 });
  });

  it('drops a leading zero so A04 and A4 are the same apartment', () => {
    expect(parseAddress('A04 gf1')).toMatchObject({ apartment: 'A4' });
    expect(parseAddress('A4gf1')).toMatchObject({ apartment: 'A4' });
  });

  it('stops at the apartment when the floor or door never got written down', () => {
    expect(parseAddress('A4')).toEqual({ kind: 'apartment', group: 'A', apartment: 'A4' });
    expect(parseAddress('C38')).toEqual({ kind: 'apartment', group: 'C', apartment: 'C38' });
    expect(parseAddress('a34 ff')).toEqual({ kind: 'apartment', group: 'A', apartment: 'A34' });
    expect(parseAddress('TIDCO C24 9866691753')).toEqual({ kind: 'apartment', group: 'C', apartment: 'C24' });
  });

  it('recognises the outlying villages, however they are spelled', () => {
    expect(parseAddress('Kapileswarapuram')).toEqual({ kind: 'village', name: 'Kapileswarapuram' });
    expect(parseAddress('KAPILESWARAPURAM')).toEqual({ kind: 'village', name: 'Kapileswarapuram' });
    expect(parseAddress('Macharamattalu')).toEqual({ kind: 'village', name: 'Macharamattalu' });
    expect(parseAddress('5-136S/O PANASARAMANNAMAIN ROADMACHARAMATALLU')).toEqual({ kind: 'village', name: 'Macharamattalu' });
    expect(parseAddress('Nandhibomma angara')).toEqual({ kind: 'village', name: 'Angara' });
  });

  it('prefers the village over a bare Z1, which is a catch-all and not a flat', () => {
    // `Z1` on its own is where the office parks anyone outside the complex, so
    // when a row carries both, the village is the only real information in it.
    expect(parseAddress('Z1   macharamattali Machramattalu')).toEqual({ kind: 'village', name: 'Macharamattalu' });
    expect(parseAddress('z1 kppuram')).toEqual({ kind: 'village', name: 'Kapileswarapuram' });

    // A Z row with a floor and door is a real flat, and still parses as one.
    expect(parseAddress('Z1 tf5')).toMatchObject({ kind: 'door', apartment: 'Z1', floor: 'TF', door: 5 });
  });

  it('gives up on rows that name no place we can resolve', () => {
    for (const raw of ['TIDCO', 'tidco', 'titco', 'Mandapeta', 'Mainroad', 'Devi center', 'JUNIOR COLLEGE', ''])
      expect(parseAddress(raw)).toEqual({ kind: 'unknown' });
  });
});
