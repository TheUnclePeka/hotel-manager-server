import { createApp } from './app.js';
import { config } from './config.js';
import { checkFilesKey } from './files.js';

checkFilesKey();
const app = await createApp();
await app.listen({ host: config.host, port: config.port });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
