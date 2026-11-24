import { createSign } from 'node:crypto';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A minimal REST client for one token. */
export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    const response = await this.fetchFn(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubError(response.status, `${method} ${url}: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Follow the Link header's `next` until `stop` holds for a page or the pages end. */
  async paginate<T>(path: string, stop: (page: T[]) => boolean = () => false): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = path;
    while (url) {
      const response = await this.send('GET', url);
      const page = (await response.json()) as T[];
      items.push(...page);
      if (stop(page)) {
        break;
      }
      url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    }
    return items;
  }
}

export interface App {
  /** The App's client ID, which GitHub takes as the JWT issuer. */
  clientId: string;
  privateKey: string;
  fetchFn?: Fetch;
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** Sign the short-lived JWT that authenticates as the App itself. */
export function appJwt(app: App, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app.clientId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(app.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Create an installation token for the named repositories of the installation. */
export async function installationToken(
  app: App,
  installationId: number,
  repositories: string[],
  permissions?: Record<string, string>,
): Promise<string> {
  const client = new GitHub(appJwt(app), app.fetchFn);
  const { token } = await client.request<{ token: string }>(
    'POST',
    `/app/installations/${installationId}/access_tokens`,
    { repositories, ...(permissions ? { permissions } : {}) },
  );
  return token;
}
