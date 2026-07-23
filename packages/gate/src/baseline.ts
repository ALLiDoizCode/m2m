import { readFileSync } from 'node:fs';
import type { GateBaseline } from './types';

export function loadBaseline(path: string): GateBaseline {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as GateBaseline;
}
