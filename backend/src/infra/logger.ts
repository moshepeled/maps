/**
 * Structured logging (SPEC section 3.6): pino JSON on stdout with `level`, ISO `time`, `instanceId`, `service` and `version`
 * on every line and secrets redacted. `LOG_PRETTY` pipes through pino-pretty in development only (env.ts forces it off
 * in production). Tests pass their own destination to capture lines.
 */
import { pino } from 'pino';
import type { DestinationStream, Logger as PinoLogger, LoggerOptions } from 'pino';

import type { AppConfig } from '../config/env.js';
import { APP_VERSION, SERVICE_NAME } from '../config/version.js';

export type Logger = PinoLogger;

/** Paths censored in every log line (section 3.6). */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.ticket',
  '*.passwordHash',
];

export interface LoggerFactoryOptions {
  /** Explicit destination (tests capture logs); disables pino-pretty. */
  destination?: DestinationStream;
}

function baseOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { instanceId: config.INSTANCE_ID, service: SERVICE_NAME, version: APP_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(config: AppConfig, options: LoggerFactoryOptions = {}): Logger {
  const settings = baseOptions(config);
  if (options.destination !== undefined) return pino(settings, options.destination);
  if (config.LOG_PRETTY) {
    return pino({
      ...settings,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,version' },
      },
    });
  }
  return pino(settings);
}
