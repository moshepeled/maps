/**
 * Shared shape of backend scripts (SPEC section 3.8): strict `parseArgs` with `--help`, zod-validated values, a pino logger
 * on stderr (results go to stdout, so `--stdout` output stays clean) and the entry-point guard.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

import { destination, pino } from 'pino';
import type { z } from 'zod';

import type { Logger } from './logger.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

export interface TextSink {
  write(chunk: string): unknown;
}

export interface ScriptIo {
  stdout: TextSink;
  stderr: TextSink;
}

export type ScriptArgs<T> = { kind: 'run'; args: T } | { kind: 'exit'; code: number };

export interface ScriptArgSpec<T> {
  argv: readonly string[];
  options: NonNullable<ParseArgsConfig['options']>;
  usage: string;
  io: ScriptIo;
  allowPositionals?: boolean;
  /** Validates the parsed `{ ...values, positionals }` object and produces the typed arguments. */
  schema: z.ZodType<T>;
}

/**
 * `--help` -> usage on stdout, exit 0. Unknown flags, unexpected positionals or invalid values -> message + usage on
 * stderr, exit 1. Otherwise the zod-validated arguments.
 */
export function parseScriptArgs<T>(spec: ScriptArgSpec<T>): ScriptArgs<T> {
  const usage = spec.usage.trimEnd();
  if (spec.argv.includes('--help') || spec.argv.includes('-h')) {
    spec.io.stdout.write(`${usage}\n`);
    return { kind: 'exit', code: EXIT_OK };
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: [...spec.argv],
      options: spec.options,
      strict: true,
      allowPositionals: spec.allowPositionals ?? false,
    });
    raw = { ...parsed.values, positionals: parsed.positionals };
  } catch (error) {
    spec.io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n${usage}\n`);
    return { kind: 'exit', code: EXIT_FAILURE };
  }
  const validated = spec.schema.safeParse(raw);
  if (!validated.success) {
    const problems = validated.error.issues.map(
      (issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`,
    );
    spec.io.stderr.write(`error: ${problems.join('; ')}\n\n${usage}\n`);
    return { kind: 'exit', code: EXIT_FAILURE };
  }
  return { kind: 'run', args: validated.data };
}

/** A JSON logger writing to stderr (fd 2), so a script's stdout carries only its result. */
export function createScriptLogger(script: string): Logger {
  return pino(
    {
      base: { script },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination(2),
  );
}

/** True when the module is the process entry point (`tsx src/scripts/x.ts` / `node dist/scripts/x.js`). */
export function isEntryPoint(importMetaUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (entry === undefined || entry === '') return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(resolve(entry))).href;
    const moduleUrl = pathToFileURL(realpathSync(fileURLToPath(importMetaUrl))).href;
    return process.platform === 'win32'
      ? entryUrl.toLowerCase() === moduleUrl.toLowerCase()
      : entryUrl === moduleUrl;
  } catch {
    return false;
  }
}
