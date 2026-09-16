/**
 * The canonical form of an email address.
 *
 * `auth.normalise_email(text)` is the same rule in SQL and the
 * `users_email_normalised` CHECK holds the column to it, so a write that skips
 * this is refused rather than quietly stored in a form nothing can find again.
 * Returns `null` for an address that is only whitespace — there is no such
 * address, and the column takes `NULL` for "none given".
 */
export function normaliseEmail(address: string | null | undefined): string | null {
  if (address == null)
    return null;

  const canonical = address.trim().toLowerCase();

  return canonical === '' ? null : canonical;
}
