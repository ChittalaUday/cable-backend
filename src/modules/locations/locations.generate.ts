import type { GenerateLevel } from './location.schema';

export interface GeneratedNode {
  parentIndex: number;
  name: string;
  code: string | null;
}

export interface ParentNode {
  name: string;
  code: string | null;
}

export const NO_PARENT: ParentNode = { name: '', code: null };

function applyTokens(template: string, values: { parent: ParentNode; index: number; label: string; name?: string }): string {
  const { parent, index, label, name } = values;

  return template
    .replaceAll('{parentCode}', parent.code ?? parent.name)
    .replaceAll('{parent}', parent.name)
    .replaceAll('{i3}', String(index).padStart(3, '0'))
    .replaceAll('{i2}', String(index).padStart(2, '0'))
    .replaceAll('{i}', String(index))
    .replaceAll('{label}', label)
    .replaceAll('{name}', name ?? label);
}

export function expandLevel(parents: readonly ParentNode[], level: GenerateLevel): GeneratedNode[] {
  const start = level.startAt ?? 1;
  const labels = level.names ?? Array.from({ length: level.count ?? 0 }, (_, i) => String(start + i));
  const out: GeneratedNode[] = [];

  for (const [parentIndex, parent] of parents.entries()) {
    for (const [offset, label] of labels.entries()) {
      const index = level.names === undefined ? start + offset : offset + start;
      const name = level.nameFormat === undefined
        ? label
        : applyTokens(level.nameFormat, { parent, index, label });
      const code = level.codeFormat === undefined
        ? null
        : applyTokens(level.codeFormat, { parent, index, label, name });

      out.push({ parentIndex, name, code });
    }
  }

  return out;
}

export function countGenerated(levels: readonly GenerateLevel[]): number {
  let width = 1;
  let total = 0;

  for (const level of levels) {
    width *= level.names?.length ?? level.count ?? 0;
    total += width;
  }

  return total;
}
