import { type GitHub, GitHubError } from './github';
import { CHECK_NAME, RESTARTED_SUMMARY } from './review';
import { docker } from './reviewer';

export interface ReconcileDeps {
  /** A client authenticated as the App itself. */
  appGitHub: () => GitHub;
  /** A client for one repository, `name` without its owner, of the installation. */
  repoGitHub: (installationId: number, name: string) => Promise<GitHub>;
  /** The reviewer containers on the engine. */
  docker: { running(): Promise<string[]>; stop(name: string): Promise<void> };
}

/** The engine's running reviewer containers, by ID. */
export const reviewerContainers: ReconcileDeps['docker'] = {
  async running() {
    const ps = Bun.spawn(['docker', 'ps', '--quiet', '--filter', 'name=^quill-'], { stderr: 'inherit' });
    const [output, status] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (status !== 0) {
      throw new Error(`docker ps exited ${status}`);
    }
    return output.split('\n').filter(Boolean);
  },
  stop: docker.stop,
};

const OPEN = ['queued', 'in_progress'];

async function reconcileRepository(repository: string, deps: ReconcileDeps): Promise<void> {
  let installation: { id: number };
  try {
    installation = await deps.appGitHub().request<{ id: number }>('GET', `/repos/${repository}/installation`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.log(`${repository}: the App is not installed; skipping its check runs`);
      return;
    }
    throw error;
  }
  const github = await deps.repoGitHub(installation.id, repository.split('/')[1]!);
  const pulls = await github.paginate<{ head: { sha: string } }>(`/repos/${repository}/pulls?state=open&per_page=100`);
  for (const { head } of pulls) {
    const { check_runs: runs } = await github.request<{ check_runs: { id: number; status: string }[] }>(
      'GET',
      `/repos/${repository}/commits/${head.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
    );
    for (const run of runs.filter(({ status }) => OPEN.includes(status))) {
      await github.request('PATCH', `/repos/${repository}/check-runs/${run.id}`, {
        status: 'completed',
        conclusion: 'cancelled',
        completed_at: new Date().toISOString(),
        output: { title: CHECK_NAME, summary: RESTARTED_SUMMARY },
      });
      console.log(`${repository}: cancelled the open check run ${run.id} on ${head.sha}`);
    }
  }
}

/** End what a crashed service left behind: its reviewer containers and its open check runs. */
export async function reconcile(repositories: string[], deps: ReconcileDeps): Promise<void> {
  try {
    const names = await deps.docker.running();
    await Promise.all(names.map((name) => deps.docker.stop(name)));
    if (names.length > 0) {
      console.log(`stopped the reviewer containers left running: ${names.join(' ')}`);
    }
  } catch (error) {
    console.error('cannot stop the reviewer containers left running', error);
  }
  for (const repository of repositories) {
    try {
      await reconcileRepository(repository, deps);
    } catch (error) {
      console.error(`${repository}: cannot cancel the open ${CHECK_NAME} check runs`, error);
    }
  }
}
