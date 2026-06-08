---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, fill forms, click elements, extract data, take screenshots, log into sites, test web apps, debug console/network issues, or automate browser tasks.
---

# agent-browser

Use the skill bundled with the installed `agent-browser` CLI instead of relying on stale copied docs.

Before running browser automation commands, load the current instructions:

```bash
agent-browser skills get core
```

For complex browser tasks, load the full bundled guide:

```bash
agent-browser skills get core --full
```

If the task needs a specialized browser workflow, list available bundled skills:

```bash
agent-browser skills list
```

Useful specialized skills include:

```bash
agent-browser skills get electron --full
agent-browser skills get slack --full
agent-browser skills get dogfood --full
agent-browser skills get vercel-sandbox --full
agent-browser skills get agentcore --full
```

Setup for end users:

```bash
npm install -g agent-browser
agent-browser install
```

Core loop after loading the current bundled instructions:

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser snapshot -i
```
