import { createApp } from './app.js';
import { loadEnv } from './env.js';

function main(): void {
  const env = loadEnv();
  const app = createApp();
  app.listen(env.PORT, () => {
    process.stdout.write(`macgruber listening on :${env.PORT}\n`);
  });
}

main();
