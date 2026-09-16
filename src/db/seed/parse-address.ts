export const TIDCO_GROUPS = ['A', 'B', 'C', 'Z'] as const;
export type TidcoGroup = (typeof TIDCO_GROUPS)[number];

export const FLOORS = ['GF', 'FF', 'SF', 'TF'] as const;
export type Floor = (typeof FLOORS)[number];

export const FLOOR_NAMES: Record<Floor, string> = {
  GF: 'Ground Floor',
  FF: 'First Floor',
  SF: 'Second Floor',
  TF: 'Third Floor',
};

const VILLAGES: readonly (readonly [fragment: string, name: string])[] = [
  ['kapileswaram', 'Kapileswaram'],
  ['kapileswarapuram', 'Kapileswaram'],
  ['kppuram', 'Kapileswaram'],
  ['angara', 'Angara'],
];

const UNIT_AND_DOOR = /([ABCZ])\s*(?:[-.,]\s*)?(\d{1,2})\s*(?:[-.,]\s*)?(GF|FF|SF|TF)\s*(?:[-.,]\s*)?(\d{1,2})/i;

const UNIT_ONLY = /([ABCZ])\s*(?:[-.,]\s*)?(\d{1,2})/i;

export type ParsedAddress
  = | { kind: 'door'; group: TidcoGroup; apartment: string; floor: Floor; door: number }
    | { kind: 'apartment'; group: TidcoGroup; apartment: string }
    | { kind: 'village'; name: string }
    | { kind: 'unknown' };

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
