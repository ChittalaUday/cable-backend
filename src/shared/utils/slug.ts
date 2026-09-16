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

  return slug || 'item';
}

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

  return `${base.slice(0, MAX_LENGTH - 14).replace(/-+$/, '')}-${Date.now().toString(36)}`;
}
