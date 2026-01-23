/**
 * Type declarations for inquirer v9
 * Inquirer v9 uses ESM and doesn't include TypeScript declarations.
 */

declare module 'inquirer' {
  export interface QuestionInput {
    type: 'input';
    name: string;
    message: string;
    default?: string;
    validate?: (input: string) => boolean | string;
  }

  export interface QuestionList {
    type: 'list';
    name: string;
    message: string;
    choices: Array<{ name: string; value: string } | string>;
    default?: string;
  }

  export interface QuestionConfirm {
    type: 'confirm';
    name: string;
    message: string;
    default?: boolean;
  }

  export interface QuestionNumber {
    type: 'number';
    name: string;
    message: string;
    default?: number;
    validate?: (input: number) => boolean | string;
  }

  export type Question = QuestionInput | QuestionList | QuestionConfirm | QuestionNumber;

  export function prompt<T = Record<string, unknown>>(questions: Question[]): Promise<T>;

  const inquirer: {
    prompt: typeof prompt;
  };

  export default inquirer;
}
