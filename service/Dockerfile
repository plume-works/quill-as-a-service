# syntax=docker/dockerfile:1
# Runs under sysbox; the reviewer containers run on its inner engine.
FROM ghcr.io/plume-works/core-systemd:edge@sha256:26ddabe6219b6eb93b48ec12a10b73212c04f68c39e069d0d48ebb5fd2527f30

COPY package.json tsconfig.json /opt/quill/
COPY src /opt/quill/src

# /etc/quill holds the deployment's settings: service.env (secrets) and config.json.
COPY <<'UNIT' /etc/systemd/system/quill.service
[Unit]
Description=Quill review service
Requires=docker.service
After=docker.service

[Service]
EnvironmentFile=/etc/quill/service.env
Environment=QUILL_CONFIG=/etc/quill/config.json
ExecStart=/usr/local/bin/bun run /opt/quill/src/server.ts
Restart=always
RestartSec=5
# SIGTERM goes to bun only, which cancels the reviews; `docker start --attach` would forward
# it to the reviewer containers, and a review would end as a failure instead.
KillMode=mixed

[Install]
WantedBy=multi-user.target
UNIT

# A stopped reviewer container is the review's log: keep it, and the rest, for a week.
COPY <<'PRUNE' /etc/systemd/system/docker-prune.service.d/quill.conf
[Service]
Environment=PRUNE_STOPPED_CONTAINERS=168h
Environment=PRUNE_ANONYMOUS_VOLUMES=168h
Environment=PRUNE_NAMED_VOLUMES=off
Environment=PRUNE_IMAGES=168h
Environment=PRUNE_BUILD_CACHE=168h
PRUNE

RUN systemctl enable quill.service
