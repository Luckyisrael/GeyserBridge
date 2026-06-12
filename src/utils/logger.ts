import pino from 'pino';
import { Config } from '../config';

let logger: pino.Logger | null = null;

export function initLogger(config: Config): pino.Logger {
  let transport: pino.TransportSingleOptions | undefined;
  try {
    require.resolve('pino-pretty');
    transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  } catch {
    // pino-pretty not installed; use default JSON output
  }

  logger = pino({
    level: config.logLevel,
    transport,
  });
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: 'info' });
  }
  return logger;
}
