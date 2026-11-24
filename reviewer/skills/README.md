# Reviewer skills

Skills the reviewer image installs for Claude, adapted from the `agentdev` plugin. Each
keeps the plugin's skills it calls; only what Quill changes is copied here.

| Skill | Copied from |
| --- | --- |
| `quill-review` | [plume-works/agent-devcontainer@f11a70b8b67a2378c87a660e8f21f998d3ba54a4](https://github.com/plume-works/agent-devcontainer/tree/f11a70b8b67a2378c87a660e8f21f998d3ba54a4/.agents/plugins/agentdev/skills/pr-review) `.agents/plugins/agentdev/skills/pr-review` |

Compare a skill with its source:

```bash
git diff --no-index <agent-devcontainer>/.agents/plugins/agentdev/skills/pr-review reviewer/skills/quill-review
```
