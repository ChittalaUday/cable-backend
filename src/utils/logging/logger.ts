import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pino from 'pino';
import { env, isLocal, isTest } from '@/config/env';

interface RotatingLogOptions {
  directory: string;
  maxFileBytes: number;
  name: string;
  now?: () => Date;
}

export function createRotatingLogDestination(options: RotatingLogOptions): pino.DestinationStream {
  const now = options.now ?? (() => new Date());
  let date = '';
  let file = '';
  let size = 0;
  let part = 1;

  function selectFile(nextDate: string, bytes: number) {
    const directory = path.resolve(options.directory, nextDate);
    mkdirSync(directory, { recursive: true });
    date = nextDate;
    part = 1;

    do {
      file = path.join(directory, `${options.name}-${part}.log`);
      size = existsSync(file) ? statSync(file).size : 0;
      part += 1;
    } while (size > 0 && size + bytes > options.maxFileBytes);

    part -= 1;
  }

  return {
    write(message: string) {
      const bytes = Buffer.byteLength(message);
      const nextDate = now().toISOString().slice(0, 10);

      if (nextDate !== date)
        selectFile(nextDate, bytes);
      else if (size > 0 && size + bytes > options.maxFileBytes)
        selectFile(nextDate, bytes);

      appendFileSync(file, message, 'utf8');
      size += bytes;
    },
  };
}

export function createLogger(name: 'api' | 'worker') {
  const options: pino.LoggerOptions = {
    level: isTest ? 'silent' : env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.refreshToken'],
  };

  if (isTest)
    return pino(options);

  const consoleStream = isLocal
    ? pino.transport({ target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } })
    : process.stdout;

  // Both streams carry an explicit level: multistream defaults an entry to
  // `info` regardless of the logger's own level, so the console has to say
  // LOG_LEVEL out loud or a LOG_LEVEL=debug run silently loses its debug lines.
  //
  // The files take LOG_FILE_LEVEL (errors) rather than everything. Fastify logs
  // a line per request, which is the right thing on a console you are watching
  // and the wrong thing on a disk you are keeping: one afternoon of load
  // testing wrote 1.2 GB across 114 rotations, none of it worth reading.
  return pino(options, pino.multistream([
    { level: env.LOG_LEVEL, stream: consoleStream },
    {
      level: env.LOG_FILE_LEVEL,
      stream: createRotatingLogDestination({
        directory: env.LOG_DIRECTORY,
        maxFileBytes: env.LOG_MAX_FILE_BYTES,
        name,
      }),
    },
  ]));
}
