import { randomBytes } from 'node:crypto';

export function generateToolName(): string {
  return `windsurf_endless_${randomBytes(4).toString('hex')}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
