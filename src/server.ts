import { approveTrustedBot, isTrustedBotPullRequest } from './approve';
import { type Config, loadConfig } from './config';
import { needsSenderPermission, wantsReview } from './decide';
import { type App, GitHub, installationToken } from './github';
import { ReviewQueue } from './queue';
import { Review } from './review';
import { reviewerToken, runContainer } from './reviewer';
import { PerKey } from './serial';
import { handleWebhook, type PullRequestEvent } from './webhook';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name}`);
  }
  return value;
};

const configPath = process.env.QUILL_CONFIG ?? '/etc/quill/config.json';
const secret = required('QUILL_WEBHOOK_SECRET');
const reviewerImage = required('QUILL_REVIEWER_IMAGE');
const claudeToken = required('CLAUDE_CODE_OAUTH_TOKEN');
// An env file holds one line per setting, so the key's newlines are written as \n.
const app: App = {
  clientId: required('QUILL_APP_CLIENT_ID'),
  privateKey: required('QUILL_APP_PRIVATE_KEY').replaceAll('\\n', '\n'),
};
const queue = new ReviewQueue(() => loadConfig(configPath).maxConcurrentReviews);
// Deliveries run at once; an approval must not land after a later delivery checked the reviews.
const trustedBotHandling = new PerKey();

async function onPullRequest(event: PullRequestEvent, config: Config): Promise<void> {
  const where = `${event.repository.full_name}#${event.pull_request.number}`;
  const github = async () =>
    new GitHub(await installationToken(app, event.installation.id, [event.repository.name]));
  if (isTrustedBotPullRequest(event, config.trustedBots)) {
    const result = await trustedBotHandling.run(where, async () => approveTrustedBot(event, await github()));
    console.log(`${where}: trusted bot, ${result}`);
    return;
  }
  let senderPermission: string | undefined;
  if (needsSenderPermission(event)) {
    const client = await github();
    ({ permission: senderPermission } = await client.request<{ permission: string }>(
      'GET',
      `/repos/${event.repository.full_name}/collaborators/${encodeURIComponent(event.sender.login)}/permission`,
    ));
  }
  if (!wantsReview({ event, paused: config.paused, senderPermission })) {
    return;
  }
  const { head, number } = event.pull_request;
  const review = new Review(event, {
    github,
    runContainer: async (signal) =>
      runContainer({
        image: reviewerImage,
        name: `quill-${event.repository.full_name.replace('/', '-')}-${number}-${head.sha.slice(0, 12)}-${Date.now()}`,
        env: {
          REPOSITORY: event.repository.full_name,
          PR_NUMBER: String(number),
          HEAD_SHA: head.sha,
          GH_TOKEN: await reviewerToken(app, event),
          CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
        },
        signal,
      }),
  });
  await queue.enqueue(review);
  console.log(`${where}: review of ${head.sha} queued after ${event.action}`);
}

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
      onPullRequest: (event, config) => {
        onPullRequest(event, config).catch((error) =>
          console.error(`${event.repository.full_name}#${event.pull_request.number}:`, error),
        );
      },
    });
  },
});
console.log(`quill listening on ${server.port}`);
