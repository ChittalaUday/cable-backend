/**
 * Slugs derived from a name, so a form never has to ask for one.
 *
 * Every catalogue create (`services`, `service_providers`, `packages`) carries
 * a slug that is unique inside its own scope — tenant, service, provider. The
 * mobile forms only collect a name, so the API derives the slug and
 * disambiguates it against what is already taken in that scope. A concurrent
 * insert can still collide; the unique index catches that and the caller gets
 * the usual 409.
 */

/** The `Slug` wire contract: `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`, 1–60 chars. */
const MAX_LENGTH = 60;

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '');

  // A name of pure punctuation or non-Latin script leaves nothing usable.
  return slug || 'item';
}

/** `basic-pack`, then `basic-pack-2`, `basic-pack-3` … as the name repeats. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const base = slugify(name);
  const used = new Set(taken);

  if (!used.has(base))
    return base;

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const room = MAX_LENGTH - String(suffix).length - 1;
    const candidate = `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
    if (!used.has(candidate))
      return candidate;
  }

  // 998 packages with one name is not a naming problem, it is a data problem.
  return `${base.slice(0, MAX_LENGTH - 14).replace(/-+$/, '')}-${Date.now().toString(36)}`;
}
