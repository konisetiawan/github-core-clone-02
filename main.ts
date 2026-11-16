import { createApp } from './app.ts';

async function main() {
  try {
    const envUrlRaw = process.env.MAKEFUN_ENV_URL;
    if (!envUrlRaw || envUrlRaw.trim() === '') {
      process.stderr.write('MAKEFUN_ENV_URL environment variable is not set\n');
      process.exit(1);
    }
    const envUrl = envUrlRaw.replace(/\/+$/, '');

    const server = createApp();

    await new Promise((resolve, reject) => {
      server.listen(0);
      server.on('listening', () => resolve(undefined));
      server.on('error', (err) => reject(err));
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to determine bound port');
    }
    const port = addr.port;
    process.stdout.write(`listening on port ${port}\n`);

    // Registration phase
    let regBackoff = 250;
    while (true) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch(`${envUrl}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (resp.status === 200 || resp.status === 409) {
          break;
        } else if (resp.status === 400 || resp.status === 405) {
          throw new Error(`Fatal registration error: status ${resp.status}`);
        }
      } catch (err) {
        if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.startsWith('Fatal registration error')) {
          throw err;
        }
        // Any other error (network or other status) retries
      }
      await new Promise((resolve) => setTimeout(resolve, regBackoff));
      regBackoff = Math.min(regBackoff * 2, 2000);
    }

    // Polling phase: wait for the test suite to signal completion
    let pollDelay = 250;
    while (true) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch(`${envUrl}/done`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (resp.status === 200) {
          const body = await resp.json();
          if (body && body.done === true) {
            break;
          }
        }
      } catch {
        // Ignore network or parsing errors and keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      pollDelay = Math.min(pollDelay * 2, 2000);
    }

    await new Promise((resolve) => {
      server.close(() => resolve(undefined));
    });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err?.message || err}\n`);
    process.exit(1);
  }
}

main();
