export function normaliseEmail(address: string | null | undefined): string | null {
  if (address == null)
    return null;

  const canonical = address.trim().toLowerCase();

  return canonical === '' ? null : canonical;
}
