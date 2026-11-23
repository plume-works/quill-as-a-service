# Deploying Quill

This guide takes a host from nothing to a running Quill service that reviews the pull
requests of the repositories in its configuration.

## What you need

- A Linux host, amd64 or arm64, with Docker Engine, the Compose plugin, and the
  [sysbox](https://github.com/nestybox/sysbox) runtime. Quill runs its reviewer
  containers on its own Docker engine, which sysbox isolates from the host's.
- A DNS name pointing at the host, for the webhook.
- A reverse proxy that terminates TLS and joins a Docker network. The example below uses
  Caddy.
- Owner access to the `plume-works` organization's Quill App (`plume-works-quill`).
- A Claude account the reviews run on.

## 1. Create the proxy network

Quill joins this network and publishes no host port. Only the proxy reaches it.

```bash
docker network create agentdev-proxy
```

Skip this if the host already has the network.

## 2. Configure the Quill App

In the App's settings on GitHub:

1. **Webhook:** active, URL `https://quill.example.com/webhook`, and a secret, for example
   from `openssl rand -hex 32`. Keep the secret for step 4.
2. **Permissions:** Checks: write, Contents: read, Issues: write, Pull requests: write,
   Metadata: read.
3. **Events:** Pull request.
4. **Private key:** generate one and download the `.pem` file.
5. Note the **Client ID** from the General page.

## 3. Get the deployment files

```bash
mkdir -p ~/quill/etc && cd ~/quill
base=https://raw.githubusercontent.com/plume-works/quill-as-a-service/main
curl -fsSLO "$base/compose.yml"
curl -fsSL "$base/service.env.example" -o etc/service.env
chmod 700 etc && chmod 600 etc/service.env
```

## 4. Write the secrets

Fill in `etc/service.env`; the file's comments say what each setting holds.

- `QUILL_WEBHOOK_SECRET`: the secret from step 2.
- `QUILL_APP_CLIENT_ID`: the App's client ID.
- `QUILL_APP_PRIVATE_KEY`: the private key on one line, in double quotes. Print it with
  `awk 'BEGIN{ORS="\\n"}1' quill.private-key.pem`, then delete the `.pem` file.
- `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on any machine, logged in to the
  account the reviews run on.
- `QUILL_REVIEWER_IMAGE`: `ghcr.io/plume-works/quill-reviewer:edge@sha256:<digest>`; get the
  digest with `docker buildx imagetools inspect ghcr.io/plume-works/quill-reviewer:edge`.

Each reviewer container gets an installation token for its one repository and the Claude
token, never the App's private key.

## 5. Write the configuration

`etc/config.json` lists what Quill reviews:

```json
{
  "repositories": ["plume-works/images"],
  "trustedBots": ["renovate[bot]", "plume-works-renovate[bot]"],
  "paused": false,
  "maxConcurrentReviews": 5
}
```

| Setting                | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `repositories`         | `owner/name` of each repository reviewed; others are ignored             |
| `trustedBots`          | Bots whose pull requests Quill approves without a review                 |
| `paused`               | `true` starts no review; running reviews finish                          |
| `maxConcurrentReviews` | Reviews that run at once; the rest wait, oldest first. Default 5         |

Quill reads the file on each webhook delivery, so an edit needs no restart.

## 6. Start the service

```bash
cd ~/quill
docker compose -p quill up -d
docker exec quill-quill-1 systemctl is-active quill docker
```

Both units report `active` once systemd has booted. Follow the service's log with
`docker exec quill-quill-1 journalctl -u quill -f`.

## 7. Route the proxy to it

Point the hostname at the container on the proxy network, port 8080:

```caddyfile
quill.example.com {
    reverse_proxy quill-quill-1:8080
}
```

A Caddy container joins the network as in the
[agent-devcontainer deployment guide](https://github.com/plume-works/agent-devcontainer/blob/main/docker/deploy/README.md#5-route-the-proxy-to-it).

## 8. Install the App and check a delivery

1. Install the Quill App on each repository in `repositories`.
2. On the App's **Advanced** page, the latest delivery shows a `2xx` response. A `401`
   means `QUILL_WEBHOOK_SECRET` does not match the App's secret.
3. Open a pull request in a configured repository. It gets a `Quill Review` check run, and
   the review from `plume-works-quill[bot]` when the check completes.

## Reading a review's log

Each review runs in a reviewer container on the service's engine. A finished container
stays, with its log and Claude's transcript, until the daily cleanup removes it a week
after it stopped:

```bash
docker exec quill-quill-1 docker ps -a --filter name=quill-
docker exec quill-quill-1 docker logs <container>
```

## Upgrading

```bash
cd ~/quill
docker compose -p quill pull && docker compose -p quill up -d
```

To move the reviewer image, set the new digest in `etc/service.env` and run
`docker exec quill-quill-1 systemctl restart quill`. Restarting the service abandons the
reviews that are running.
