/**
 * OpenAPI export (SPEC section 12.1, S6): builds the fully wired app (every module registered, nothing listening) and
 * writes its OpenAPI 3.1 document to `docs/openapi.json` (`--out <file>`), or prints it (`--stdout`). Logs go to
 * stderr so `--stdout` output is pure JSON. No database or Redis round trip is needed to generate the document.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { destination } from 'pino';
import { z } from 'zod';

import { buildApp } from '../app.js';
import { loadConfigFromEnv } from '../config/env.js';
import type { AppConfig } from '../config/env.js';
import { createContainer } from '../container.js';
import { EXIT_FAILURE, EXIT_OK, createScriptLogger, isEntryPoint, parseScriptArgs } from '../infra/cli.js';
import type { ScriptIo } from '../infra/cli.js';
import { createLogger } from '../infra/logger.js';
import type { Logger } from '../infra/logger.js';

/** `<repo>/docs/openapi.json` */
export const DEFAULT_OUT = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

const USAGE = `Usage: export-openapi [--out <file> | --stdout]

  --out <file>  write the document to <file> (default: docs/openapi.json)
  --stdout      print the document instead of writing a file
  -h, --help    show this help`;

const ArgsSchema = z
  .object({
    out: z.string().min(1).optional(),
    stdout: z.boolean().optional(),
    positionals: z.array(z.never()),
  })
  .refine((args) => !(args.out !== undefined && args.stdout === true), {
    message: 'use either --out or --stdout',
  });

export interface ExportOpenApiDeps extends ScriptIo {
  loadConfig(): AppConfig;
  /** Builds the OpenAPI document of the fully wired app. */
  generate(config: AppConfig): Promise<unknown>;
  writeFile(path: string, content: string): Promise<void>;
  logger: Logger;
}

/** Generates the document from a container whose logs go to stderr; always closes the container. */
export async function generateOpenApiDocument(config: AppConfig): Promise<unknown> {
  const container = createContainer(config, {
    logger: createLogger(config, { destination: destination(2) }),
  });
  try {
    const snap = await buildApp(container);
    await snap.app.ready();
    const document = snap.app.swagger();
    await snap.app.close();
    return document;
  } finally {
    await container.close();
  }
}

function defaultDeps(): ExportOpenApiDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    loadConfig: loadConfigFromEnv,
    generate: generateOpenApiDocument,
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    logger: createScriptLogger('export-openapi'),
  };
}

export async function run(
  argv: readonly string[],
  overrides: Partial<ExportOpenApiDeps> = {},
): Promise<number> {
  const deps: ExportOpenApiDeps = { ...defaultDeps(), ...overrides };
  const cli = parseScriptArgs({
    argv,
    options: { out: { type: 'string' }, stdout: { type: 'boolean' } },
    usage: USAGE,
    io: deps,
    schema: ArgsSchema,
  });
  if (cli.kind === 'exit') return cli.code;

  try {
    const document = await deps.generate(deps.loadConfig());
    const json = `${JSON.stringify(document, null, 2)}\n`;
    if (cli.args.stdout === true) {
      deps.stdout.write(json);
      return EXIT_OK;
    }
    const out = resolve(cli.args.out ?? DEFAULT_OUT);
    await deps.writeFile(out, json);
    deps.logger.info({ out, bytes: Buffer.byteLength(json) }, 'OpenAPI document written');
    deps.stdout.write(`${JSON.stringify({ out, bytes: Buffer.byteLength(json) })}\n`);
    return EXIT_OK;
  } catch (error) {
    deps.logger.error({ err: error }, 'OpenAPI export failed');
    return EXIT_FAILURE;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
