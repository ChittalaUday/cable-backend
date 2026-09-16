export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function likeTerm(value: string): string {
  return `%${escapeLike(value)}%`;
}
