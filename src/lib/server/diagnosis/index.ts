// Root-cause diagnosis (docs/ARCHITECTURE.md §6): runDiagnosis(from, to) reads SQLite (bounded
// queries, input.ts) and evaluates the pure rules R01–R20 (report.ts). Server only.
import type { DiagnosisReport } from '../../shared/types';
import { buildDiagnosisInput } from './input';
import { diagnose } from './report';

export { buildDiagnosisInput } from './input';
export type { BuildInputOptions } from './input';
export { diagnose, gamingScoreFor } from './report';
export { RULES } from './rules';
export type { DiagnosisInput } from './types';

/**
 * Diagnosis report for [from, to) (epoch ms). Synchronous (node:sqlite); never throws for an
 * empty database – the verdict then says honestly that data is missing.
 * @throws RangeError for a non-finite or empty range
 */
export function runDiagnosis(from: number, to: number): DiagnosisReport {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new RangeError('Ungültiger Zeitraum für die Diagnose');
  }
  return diagnose(buildDiagnosisInput(from, to));
}
