# syntax=docker/dockerfile:1
FROM ghcr.io/plume-works/core:edge@sha256:0ab686a9f230c26369355a71e00084b8c934fee4629a95b1a9f550a79a7e5c31

# renovate: datasource=git-refs depName=https://github.com/plume-works/agent-devcontainer currentValue=main
ARG AGENTDEV_COMMIT=f11a70b8b67a2378c87a660e8f21f998d3ba54a4

RUN git init -q /opt/agent-devcontainer \
  && git -C /opt/agent-devcontainer fetch -q --depth 1 \
    https://github.com/plume-works/agent-devcontainer.git "${AGENTDEV_COMMIT}" \
  && git -C /opt/agent-devcontainer checkout -q --detach FETCH_HEAD

COPY reviewer/review.py /usr/local/bin/review

USER dev
WORKDIR /home/dev
RUN claude plugin marketplace add /opt/agent-devcontainer \
  && claude plugin install agentdev@agent-devcontainer --scope user
COPY --chown=dev:dev reviewer/settings.json /home/dev/.claude/settings.json

ENTRYPOINT ["/usr/local/bin/review"]
