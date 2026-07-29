/**
 * Structured logs in production, readable ones in development.
 *
 * Nothing logged here ever reaches a user: the dispatcher's error boundary sends a generic
 * message and logs the detail, so internals cannot leak through an error string.
 */
import pino from 'pino';
import { env } from './env.ts';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Cheap insurance: if a token ever ends up on a log line, it is redacted rather than stored.
  redact: {
    paths: ['token', '*.token', 'DISCORD_TOKEN', '*.DISCORD_TOKEN'],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});
