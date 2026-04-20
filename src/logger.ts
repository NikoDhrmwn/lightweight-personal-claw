/**
 * LiteClaw — Structured Logger
 * 
 * Pretty, structured terminal output for all components.
 * Uses pino underneath with a custom pretty transport.
 */

import pino from 'pino';
import chalk from 'chalk';

// ─── Timestamp Formatter ─────────────────────────────────────────────

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return chalk.gray(`${h}:${m}:${s}`);
}

// ─── Component Colors ────────────────────────────────────────────────

const COMPONENT_COLORS: Record<string, (s: string) => string> = {
  'gateway':    chalk.cyan,
  'engine':     chalk.magenta,
  'discord':    chalk.blueBright,
  'whatsapp':   chalk.green,
  'config':     chalk.yellow,
  'memory':     chalk.gray,
  'tools':      chalk.hex('#FF8C00'),
  'migrate':    chalk.hex('#9B59B6'),
};

// ─── Level Styling ───────────────────────────────────────────────────

const LEVEL_LABELS: Record<number, string> = {
  10: chalk.gray('TRACE'),
  20: chalk.blue('DEBUG'),
  30: chalk.green(' INFO'),
  40: chalk.yellow(' WARN'),
  50: chalk.red('ERROR'),
  60: chalk.bgRed.white('FATAL'),
};

// ─── Pretty Formatter ────────────────────────────────────────────────

function formatLogLine(obj: any): string {
  const level = LEVEL_LABELS[obj.level] ?? chalk.white('???');
  const rawName = (obj.name ?? 'liteclaw').replace('liteclaw:', '');
  const colorFn = COMPONENT_COLORS[rawName] ?? chalk.white;
  const component = colorFn(rawName.padEnd(10));
  const msg = obj.msg ?? '';

  // Build extra context (exclude standard pino fields)
  const skipKeys = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg', 'v']);
  const extras: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (skipKeys.has(key)) continue;
    if (typeof val === 'object') continue; // Skip nested objects for cleanliness
    extras.push(`${chalk.gray(key)}=${chalk.white(String(val))}`);
  }

  const extraStr = extras.length > 0 ? ` ${chalk.gray('·')} ${extras.join(' ')}` : '';

  return `${timestamp()} ${level} ${component} ${msg}${extraStr}`;
}

// ─── Custom Stream ───────────────────────────────────────────────────

const customStream = {
  write: (msg: string) => {
    try {
      const obj = JSON.parse(msg);
      console.log(formatLogLine(obj));
    } catch {
      process.stdout.write(msg);
    }
  }
};

// ─── Create Logger ───────────────────────────────────────────────────

export function createLogger(name: string): pino.Logger {
  const isVerbose = process.env.LITECLAW_VERBOSE === '1' || 
                    process.argv.includes('--verbose') || 
                    process.argv.includes('-v');

  return pino({
    name: `liteclaw:${name}`,
    level: isVerbose ? 'debug' : 'info',
  }, customStream);
}

/**
 * Create a silent logger (for Baileys which is extremely noisy).
 */
export function createSilentLogger(name: string): pino.Logger {
  return pino({
    name: `liteclaw:${name}`,
    level: 'warn', // Only show warnings and errors from noisy libraries
  }, customStream);
}

// ─── Startup Banner ──────────────────────────────────────────────────

export function printBanner(version: string): void {
  console.log('');
  console.log(chalk.green.bold(`  🦎 LiteClaw v${version}`));
  console.log(chalk.gray(`  ─────────────────────────────`));
  console.log('');
}

export function printSection(label: string): void {
  console.log(chalk.gray(`  ┌─ ${label}`));
}

export function printStep(icon: string, text: string): void {
  console.log(chalk.gray('  │ ') + `${icon} ${text}`);
}

export function printStepDone(text: string): void {
  console.log(chalk.gray('  │ ') + chalk.green('✓') + ` ${text}`);
}

export function printStepWarn(text: string): void {
  console.log(chalk.gray('  │ ') + chalk.yellow('⚠') + ` ${text}`);
}

export function printStepError(text: string): void {
  console.log(chalk.gray('  │ ') + chalk.red('✗') + ` ${text}`);
}

export function printStepSkip(text: string): void {
  console.log(chalk.gray('  │ ') + chalk.gray('○') + ` ${chalk.gray(text)}`);
}

export function printSectionEnd(): void {
  console.log(chalk.gray('  └─────────────────────────────'));
  console.log('');
}

export function printReady(binds: { port: number; bind: string }): void {
  const url = `http://${binds.bind}:${binds.port}`;
  console.log(chalk.gray('  ┌─────────────────────────────'));
  console.log(chalk.gray('  │ ') + chalk.green.bold('Gateway Ready'));
  console.log(chalk.gray('  │'));
  console.log(chalk.gray('  │ ') + `🌐 WebUI     ${chalk.cyan(url)}`);
  console.log(chalk.gray('  │ ') + `📡 WebSocket  ${chalk.cyan(`ws://${binds.bind}:${binds.port}/ws`)}`);
  console.log(chalk.gray('  │ ') + `❤️  Health     ${chalk.cyan(`${url}/health`)}`);
  console.log(chalk.gray('  └─────────────────────────────'));
  console.log('');
}
