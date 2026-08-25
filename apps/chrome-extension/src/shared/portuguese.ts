export function inflectPortuguese(
  count: number,
  singular: string,
  plural: string,
): string {
  return count === 1 ? singular : plural;
}

export function formatPortugueseQuantity(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${String(count)} ${inflectPortuguese(count, singular, plural)}`;
}
