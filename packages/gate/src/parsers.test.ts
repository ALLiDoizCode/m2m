import { sumEslintCounts, countTscErrors } from './parsers';

describe('sumEslintCounts', () => {
  it('returns zero for no files', () => {
    expect(sumEslintCounts([])).toEqual({ errors: 0, warnings: 0 });
  });

  it('sums errorCount and warningCount across files', () => {
    const result = sumEslintCounts([
      { errorCount: 1, warningCount: 2 },
      { errorCount: 0, warningCount: 3 },
      { errorCount: 2, warningCount: 0 },
    ]);

    expect(result).toEqual({ errors: 3, warnings: 5 });
  });
});

describe('countTscErrors', () => {
  it('returns zero when tsc reports no errors', () => {
    expect(countTscErrors('')).toBe(0);
  });

  it('counts one match per "error TS" diagnostic line', () => {
    const output = [
      "src/foo.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/bar.ts(10,1): error TS2304: Cannot find name 'Baz'.",
    ].join('\n');

    expect(countTscErrors(output)).toBe(2);
  });

  it('does not count unrelated output lines', () => {
    const output = 'Found 0 errors. Watching for file changes.';

    expect(countTscErrors(output)).toBe(0);
  });
});
