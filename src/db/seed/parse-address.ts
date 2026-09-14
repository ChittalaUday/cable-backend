/**
 * The address column of the MSO report, turned into a place in the tree.
 *
 * Nobody validated this field for fifteen years, so the same flat is written
 * `A31sf1`, `A31 SF 1`, `A31. Sf1`, `TIDCO A31 sf1 TIDCO HOUSES` and
 * `Address TDICO A31. Sf1`. All of them mean Group A, apartment A31, second
 * floor, door 1 — so the parser looks for the shape rather than the format,
 * and everything it cannot place falls back to a node further up.
 */

/** The groups the TIDCO complex is actually divided into. */
export const TIDCO_GROUPS = ['A', 'B', 'C', 'Z'] as const;
export type TidcoGroup = (typeof TIDCO_GROUPS)[number];

/** Ground, first, second and third floor, as the report writes them. */
export const FLOORS = ['GF', 'FF', 'SF', 'TF'] as const;
export type Floor = (typeof FLOORS)[number];

export const FLOOR_NAMES: Record<Floor, string> = {
  GF: 'Ground Floor',
  FF: 'First Floor',
  SF: 'Second Floor',
  TF: 'Third Floor',
};

/**
 * Villages outside the complex, matched on a fragment because the report
 * spells several of them more than one way (`MACHARAMATALLU`, `Machramattalu`).
 */
const VILLAGES: readonly (readonly [fragment: string, name: string])[] = [
  ['kapileswarapuram', 'Kapileswarapuram'],
  ['kppuram', 'Kapileswarapuram'],
  ['macharamat', 'Macharamattalu'],
  ['machramat', 'Macharamattalu'],
  ['yandagandi', 'Yandagandi'],
  ['kanjulapeta', 'Kanjulapeta'],
  ['kutukulur', 'Kutukulur'],
  ['angara', 'Angara'],
];

/** `A31 SF 1`, `A31sf1`, `C-66, GF4`, `A38. Gf 4` — punctuation and spacing are noise. */
const UNIT_AND_DOOR = /([ABCZ])\s*(?:[-.,]\s*)?(\d{1,2})\s*(?:[-.,]\s*)?(GF|FF|SF|TF)\s*(?:[-.,]\s*)?(\d{1,2})/i;

/** The same, for a row that names the apartment but never got a floor or door. */
const UNIT_ONLY = /([ABCZ])\s*(?:[-.,]\s*)?(\d{1,2})/i;

export type ParsedAddress
  /** Placed all the way down to a door. */
  = | { kind: 'door'; group: TidcoGroup; apartment: string; floor: Floor; door: number }
  /** In the complex, in a known apartment, but the floor or door is missing. */
    | { kind: 'apartment'; group: TidcoGroup; apartment: string }
  /** Outside the complex, in a village the street hierarchy covers. */
    | { kind: 'village'; name: string }
  /** Nothing usable — the caller falls back to the complex or the town. */
    | { kind: 'unknown' };

/**
 * `A31sf1` → Group A, apartment A31, Second Floor, door 1.
 *
 * A row that names both a village and a bare `Z1` resolves to the village:
 * `Z1` is where the office parks anyone outside the complex, so the village is
 * the only real information in it. A `Z` row with a floor and door is a flat,
 * and the door pattern above catches it first.
 */
export function parseAddress(raw: string): ParsedAddress {
  const text = raw.replace(/\s+/g, ' ').trim();

  const full = UNIT_AND_DOOR.exec(text);
  if (full !== null) {
    const group = full[1]!.toUpperCase() as TidcoGroup;
    return {
      kind: 'door',
      group,
      apartment: `${group}${Number(full[2])}`,
      floor: full[3]!.toUpperCase() as Floor,
      door: Number(full[4]),
    };
  }

  const unit = UNIT_ONLY.exec(text);
  const lower = text.toLowerCase();
  const village = VILLAGES.find(([fragment]) => lower.includes(fragment));

  if (unit !== null && village === undefined) {
    const group = unit[1]!.toUpperCase() as TidcoGroup;
    return { kind: 'apartment', group, apartment: `${group}${Number(unit[2])}` };
  }

  if (village !== undefined)
    return { kind: 'village', name: village[1] };

  return { kind: 'unknown' };
}
