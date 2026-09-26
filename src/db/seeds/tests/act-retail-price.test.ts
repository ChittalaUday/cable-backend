import { describe, expect, it } from 'vitest';
import { actRetailPrice } from '../seed-packages-channels';

const base = { packageType: 'base' as const, billingCycle: 'quarterly' as const };

describe('actRetailPrice', () => {
  it('adds the markup once per month of the pack, rounded up to the next ₹5', () => {
    // 448.99 + 1135 × 3 = 3853.99
    expect(actRetailPrice({ ...base, name: 'ACT_ULTIMATE_03_MONTHS_LCO PACK_VIZ', price: '448.99' })).toBe('3855.00');
    // 1126.78 + 1135 × 6 = 7936.78
    expect(actRetailPrice({ ...base, billingCycle: 'semi_annual', name: 'ACT_SMART_HD_06_MONTHS_LCO PACK_VIZ', price: '1126.78' })).toBe('7940.00');
    // 2101.02 + 1135 × 12 = 15721.02
    expect(actRetailPrice({ ...base, billingCycle: 'annual', name: 'ACT_HINDI_12_MONTHS_LCO PACK_VIZ', price: '2101.02' })).toBe('15725.00');
  });

  it('never rounds down', () => {
    // Exactly on a ₹5 mark stays put; a paise over goes to the next one.
    expect(actRetailPrice({ ...base, billingCycle: 'monthly', name: 'ACT X', price: '65.00' })).toBe('1200.00');
    expect(actRetailPrice({ ...base, billingCycle: 'monthly', name: 'ACT X', price: '65.01' })).toBe('1205.00');
  });

  it('leaves addons, a-la-carte and other providers at the MSO rate', () => {
    expect(actRetailPrice({ ...base, packageType: 'bouquet', name: 'ACT SMART_HD_PRE_VIZ', price: '187.80' })).toBe('187.80');
    expect(actRetailPrice({ ...base, packageType: 'ala_carte', name: 'ACT SOMETHING', price: '19.00' })).toBe('19.00');
    expect(actRetailPrice({ ...base, name: 'ACTION PACK', price: '100.00' })).toBe('100.00');
    expect(actRetailPrice({ ...base, name: 'DD_PACK_PRE_VIZ', price: '100.00' })).toBe('100.00');
  });

  it('leaves the free basic tier alone', () => {
    expect(actRetailPrice({ ...base, billingCycle: 'monthly', name: 'ACT_BST_PRE_VIZ', price: '0.00' })).toBe('0.00');
  });
});
