import { loadConfig } from './config';
import { handleWebhook } from './webhook';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name}`);
  }
  return value;
};

const configPath = process.env.QUILL_CONFIG ?? '/etc/quill/config.json';
const secret = required('QUILL_WEBHOOK_SECRET');

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST' || pathname !== '/webhook') {
      return new Response('not found\n', { status: 404 });
    }
    return handleWebhook(request, {
      secret,
      config: () => loadConfig(configPath),
      onPullRequest: (event) => {
        console.log(`pull_request ${event.action} ${event.repository.full_name}#${event.pull_request.number}`);
      },
    });
  },
});
console.log(`quill listening on ${server.port}`);
