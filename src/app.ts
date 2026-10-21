import fs from 'node:fs';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ensureAdmin, registerAuthRoutes } from './auth.js';
import { config, filesDir, updatesDir } from './config.js';
import { initDb, sql } from './db.js';
import { migrate } from './migrate.js';
import { registerRoutes } from './routes.js';
import { startScheduler } from './scheduler.js';
import { seed } from './seed.js';

export async function createApp(opts: { databaseUrl?: string; scheduler?: boolean; logger?: boolean } = {}): Promise<FastifyInstance> {
  for (const d of [config.dataDir, filesDir(), updatesDir()]) fs.mkdirSync(d, { recursive: true });
  initDb(opts.databaseUrl);
  const log = (m: string) => console.log(`[hotelmanager] ${m}`);
  await migrate(sql, log);
  await seed(log);
  await ensureAdmin(log);

  const https = config.tlsCert && config.tlsKey ? { key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert) } : null;
  const app = Fastify({
    ...(https ? { https } : {}),
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ['req.headers.authorization','req.headers.cookie'] },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: config.singleProxy ? (_address:string,hop:number)=>hop===0 : false,
  });
  // Клиенты — приложения (Electron, Capacitor) и dev-сервер интерфейса.
  await app.register(cors, { origin: config.allowedOrigins });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: `Неверные данные: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
  });

  registerAuthRoutes(app);
  registerRoutes(app);
  if (opts.scheduler !== false) startScheduler();
  return app;
}
