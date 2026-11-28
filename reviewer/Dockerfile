# syntax=docker/dockerfile:1
FROM ghcr.io/plume-works/core:edge@sha256:e7816a63fa18d0e0810d7cf1144569df0f668e4928e5157ba427c8761e910bc9

# renovate: datasource=git-refs depName=https://github.com/plume-works/agent-devcontainer currentValue=main
ARG AGENTDEV_COMMIT=66ec990d1774d659aadebca9fed71ec59b6518a3

RUN git init -q /opt/agent-devcontainer \
  && git -C /opt/agent-devcontainer fetch -q --depth 1 \
    https://github.com/plume-works/agent-devcontainer.git "${AGENTDEV_COMMIT}" \
  && git -C /opt/agent-devcontainer checkout -q --detach FETCH_HEAD

COPY reviewer/review.py /usr/local/bin/review
# The review's result, which the service copies out of the stopped container.
RUN install -d -o dev -g dev /review
# Managed settings outrank any other source, and the reviewer cannot write them.
COPY reviewer/settings.json /etc/claude-code/managed-settings.json

USER dev
WORKDIR /home/dev
RUN claude plugin marketplace add /opt/agent-devcontainer \
  && claude plugin install agentdev@agent-devcontainer --scope user
COPY --chown=dev:dev reviewer/skills/quill-review /home/dev/.claude/skills/quill-review

ENTRYPOINT ["/usr/local/bin/review"]
