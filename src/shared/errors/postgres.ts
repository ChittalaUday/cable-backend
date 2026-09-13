function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined;

  if ('code' in error && typeof error.code === 'string')
    return error.code;

  return 'cause' in error ? codeOf(error.cause) : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  const code = codeOf(error);

  return code === '23503' || code === '23001';
}
