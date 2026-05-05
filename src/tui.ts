/**
 * LiteClaw — Terminal UI Helpers
 *
 * Wraps @inquirer/prompts with LiteClaw styling and provides
 * section-based onboarding flow with arrow-key navigation.
 */

import { select, confirm, input, number } from '@inquirer/prompts';
import chalk from 'chalk';

// ─── Brand Constants ─────────────────────────────────────────────────

const BRAND = '🦎';
const DIM_LINE = chalk.dim('─'.repeat(52));

// ─── Themed Prompt Wrappers ──────────────────────────────────────────

export async function tuiSelect<T extends string>(opts: {
  message: string;
  choices: Array<{ value: T; name: string; description?: string }>;
  default?: T;
}): Promise<T> {
  return select<T>({
    message: opts.message,
    choices: opts.choices.map(c => ({
      value: c.value,
      name: c.name,
      description: c.description,
    })),
    default: opts.default,
    theme: {
      prefix: chalk.cyan('?'),
      style: {
        highlight: (text: string) => chalk.cyan.bold(text),
        answer: (text: string) => chalk.green(text),
      },
    },
  });
}

export async function tuiConfirm(opts: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  return confirm({
    message: opts.message,
    default: opts.default ?? true,
    theme: {
      prefix: chalk.cyan('?'),
      style: {
        answer: (text: string) => chalk.green(text),
      },
    },
  });
}

export async function tuiInput(opts: {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string;
}): Promise<string> {
  return input({
    message: opts.message,
    default: opts.default,
    validate: opts.validate,
    theme: {
      prefix: chalk.cyan('?'),
      style: {
        answer: (text: string) => chalk.green(text),
      },
    },
  });
}

export async function tuiNumber(opts: {
  message: string;
  default?: number;
  min?: number;
  max?: number;
}): Promise<number> {
  const result = await number({
    message: opts.message,
    default: opts.default,
    min: opts.min,
    max: opts.max,
    theme: {
      prefix: chalk.cyan('?'),
      style: {
        answer: (text: string) => chalk.green(text),
      },
    },
  });
  return result ?? opts.default ?? 0;
}

// ─── Visual Helpers ──────────────────────────────────────────────────

export function printBanner(version: string): void {
  console.log();
  console.log(chalk.bold.cyan(`  ${BRAND} LiteClaw ${version}`));
  console.log(chalk.dim('  Lightweight agent runtime for local LLMs'));
  console.log(DIM_LINE);
  console.log();
}

export function printSection(title: string, stepCurrent?: number, stepTotal?: number): void {
  console.log();
  const progress = stepCurrent != null && stepTotal != null
    ? chalk.dim(` (${stepCurrent}/${stepTotal})`)
    : '';
  console.log(chalk.bold.cyan(`  ▸ ${title}${progress}`));
  console.log(chalk.dim('  ' + '─'.repeat(title.length + 4)));
  console.log();
}

export function printSuccess(message: string): void {
  console.log(chalk.green(`  ✓ ${message}`));
}

export function printInfo(message: string): void {
  console.log(chalk.gray(`  ${message}`));
}

export function printWarning(message: string): void {
  console.log(chalk.yellow(`  ⚠ ${message}`));
}

export function printHint(message: string): void {
  console.log(chalk.dim(`    ${message}`));
}

export function printDone(lines: string[]): void {
  console.log();
  console.log(DIM_LINE);
  console.log(chalk.bold.green(`  ${BRAND} Setup complete!\n`));
  for (const line of lines) {
    console.log(chalk.gray(`  ${line}`));
  }
  console.log();
}

export function printKeyValue(key: string, value: string): void {
  console.log(`  ${chalk.dim(key.padEnd(20))} ${chalk.white(value)}`);
}
