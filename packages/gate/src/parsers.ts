export interface EslintFileResult {
  errorCount: number;
  warningCount: number;
}

export function sumEslintCounts(results: EslintFileResult[]): {
  errors: number;
  warnings: number;
} {
  return results.reduce(
    (acc, r) => ({ errors: acc.errors + r.errorCount, warnings: acc.warnings + r.warningCount }),
    { errors: 0, warnings: 0 }
  );
}

export function countTscErrors(output: string): number {
  const matches = output.match(/error TS\d+:/g);
  return matches ? matches.length : 0;
}
