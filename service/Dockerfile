# syntax=docker/dockerfile:1
# Runs under sysbox; the reviewer containers run on its inner engine.
FROM ghcr.io/plume-works/core-systemd:edge@sha256:f3ee3b4852e22aaac688cbab2efa1b567ec79b0f7389a4c11c488ed9d6c892d4

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
