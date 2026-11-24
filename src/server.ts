import { approveTrustedBot, isTrustedBotPullRequest } from './approve';
import { type Config, loadConfig } from './config';
import { cancelsReview, headIsCurrent, needsSenderPermission, wantsReview } from './decide';
import { type App, appJwt, GitHub, installationToken } from './github';
import { ReviewQueue } from './queue';
import { reconcile, reviewerContainers } from './reconcile';
import { Review } from './review';
import { readResult, reviewerToken, runContainer } from './reviewer';
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
// Deliveries of a pull request run in arrival order, so an older head never replaces a newer one.
const pullRequestDeliveries = new PerKey();

const onPullRequest = (event: PullRequestEvent, config: Config): Promise<void> =>
  pullRequestDeliveries.run(`${event.repository.full_name}#${event.pull_request.number}`, () =>
    handlePullRequest(event, config),
  );

async function handlePullRequest(event: PullRequestEvent, config: Config): Promise<void> {
  const where = `${event.repository.full_name}#${event.pull_request.number}`;
  const github = async () =>
    new GitHub(await installationToken(app, event.installation.id, [event.repository.name]));
  if (isTrustedBotPullRequest(event, config.trustedBots)) {
    const result = await approveTrustedBot(event, await github());
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
  const decision = { event, paused: config.paused, senderPermission };
  if (cancelsReview(decision)) {
    await queue.cancel(where);
    return;
  }
  if (!wantsReview(decision)) {
    return;
  }
  const { head, number } = event.pull_request;
  if (!(await headIsCurrent(event, await github()))) {
    console.log(`${where}: ${head.sha} is no longer the head, skipping the review after ${event.action}`);
    return;
  }
  const name = `quill-${event.repository.full_name.replace('/', '-')}-${number}-${head.sha.slice(0, 12)}-${Date.now()}`;
  const review = new Review(event, {
    github,
    readResult: () => readResult(name),
    runContainer: async (signal) =>
      runContainer({
        image: reviewerImage,
        name,
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

try {
  await reconcile(loadConfig(configPath).repositories, {
    appGitHub: () => new GitHub(appJwt(app)),
    repoGitHub: async (installationId, name) => new GitHub(await installationToken(app, installationId, [name])),
    docker: reviewerContainers,
  });
} catch (error) {
  console.error('cannot reconcile the reviews of the previous run', error);
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

let stopping: Promise<never> | undefined;
const stop = (signal: string) => {
  stopping ??= (async () => {
    console.log(`quill stopping on ${signal}`);
    void server.stop();
    await queue.shutdown();
    process.exit(0);
  })();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
