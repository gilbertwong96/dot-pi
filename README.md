# dot-pi

A curated Pi package with extensions, skills, prompt shortcuts, and rules.

## Install

Install Pi first:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Then install this package:

```bash
pi install git:github.com/dannote/dot-pi
```

Project-local install for a repo/team:

```bash
pi install -l git:github.com/dannote/dot-pi
```

If Pi is already installed, you can also let Pi do the setup for you. Start `pi` and paste:

```text
Read https://github.com/dannote/dot-pi and set up dot-pi for me. Install the package, install agent-browser if missing, and offer the optional companion packages pi-computer-use, pi-subagents, and pi-context before installing them.
```

Start Pi and use `pi config` to review or change what is enabled:

```bash
pi config
```

Update Pi and installed packages later with:

```bash
pi update
```

Useful companion packages, installed separately when you want them:

```bash
pi install git:github.com/injaneity/pi-computer-use@v0.2.6  # macOS computer use
pi install npm:pi-subagents                                 # subagent delegation
pi install npm:pi-context                                   # context history tags/checkouts
```

`pi-computer-use` is especially useful for visible macOS apps. It adds semantic window/screenshot tools and prefers Accessibility refs over coordinates.

## What is enabled by default

The default install focuses on broadly useful, low-surprise tools.

### Extensions

| Extension | Description | Extra setup |
|---|---|---|
| `ast-grep.ts` | AST-based code search and rewrite | `brew install ast-grep` |
| `background.ts` | Start/stop long-running dev servers and watchers | None |
| `codesearch.ts` | Search public GitHub code via grep.app | None |
| `confirm-destructive.ts` | Ask before high-risk local actions | None |
| `context7/` | Fetch current library docs from Context7 | None |
| `lsp/` | LSP tools: definitions, references, diagnostics, rename | Install language servers as needed |
| `notify.ts` | Desktop notification when work completes | macOS notifications enabled |
| `question.ts` | Let the agent ask selectable questions | None |
| `webfetch/` | Fetch URL content as markdown/text/html/json | None |
| `websearch/` | Web search via Exa | `EXA_API_KEY` |
| `worktrees/` | Git worktree helpers for isolated work | None |

### Prompt shortcuts

| Prompt | Expands to |
|---|---|
| `/all` | Do all pending items without piecemeal confirmation |
| `/ar` | Resume an autoresearch loop from persisted state |
| `/lgtm` | Approve the current direction and proceed autonomously |
| `/next [count]` | Summarize state and list next steps |
| `/push` | Commit and push when appropriate |
| `/release` | Prepare release artifacts and final checks |
| `/retry` | Retry the last failed or incomplete operation |
| `/verify` | Run relevant checks and fix failures |

### Skills

| Skill | Description | Extra setup |
|---|---|---|
| `agent-browser` | Browser automation via agent-browser CLI. This wrapper loads current docs from `agent-browser skills get core` instead of vendoring them. | `npm install -g agent-browser && agent-browser install` |
| `github-issues` | Work with GitHub Issues via `gh` | `gh auth login` |
| `keyboard-layout-decoder` | Decode Russian/English wrong-keyboard-layout text | None |
| `skill-discovery` | Discover agent skills on GitHub | None |

## Optional resources

These are included in the repo but not enabled by default because they are experimental, personal, platform-specific, or require extra credentials.

Enable them by replacing the package entry in `~/.pi/agent/settings.json` with an object-form package filter. Use `+path` to opt into resources outside the default manifest.

### Optional extensions

| Extension | Why optional |
|---|---|
| `bash-completion/` | Advanced terminal completion; can be noisy while editing prompts |
| `critic/` | Experimental shadow-review loop |
| `decision-guidance.ts` | Experimental trajectory guidance |
| `env-json/` | Only useful if you keep secrets in `~/.pi/agent/env.jsonc` |
| `permission-gate.ts` | Opinionated command blocking |
| `plan-mode/` | Experimental read-only planning mode |
| `provider/` | Experimental dynamic provider registration |
| `rules.ts` | Personal rule loader for symlinked files in `~/.pi/agent/rules/` |
| `sandbox/` | Experimental OS-level sandboxing |
| `voice-input/` | Requires ElevenLabs key and audio setup |

### Optional skills

| Skill | Why optional |
|---|---|
| `ai-news` | Personal AI news workflow using X/Twitter |
| `applescript` | macOS-only automation |
| `bird` | X/Twitter workflow; requires bird CLI/auth |
| `chat-to-skill` | Meta workflow for creating new skills |
| `vibe-merge` | Specialized PR/branch reimplementation workflow |

Example package filter enabling only voice input and AppleScript:

```json
{
  "packages": [
    {
      "source": "git:github.com/dannote/dot-pi",
      "extensions": ["+extensions/voice-input"],
      "skills": ["+skills/applescript"],
      "prompts": ["prompts"]
    }
  ]
}
```

## Rules

Rules are intentionally not enabled through the package. They are personal preference files. Symlink the ones you want into `~/.pi/agent/rules/`:

```bash
mkdir -p ~/.pi/agent/rules
ln -s /path/to/dot-pi/rules/typescript.md ~/.pi/agent/rules/
```

| Rule | Description |
|---|---|
| `backward-compatibility.md` | Avoid unnecessary compatibility shims |
| `bun.md` | Use Bun instead of Node.js/npm |
| `comments.md` | Avoid redundant comments |
| `commit-messages.md` | Follow existing repo commit style |
| `delete-files.md` | Use `rm -f` to delete files |
| `git-hosting.md` | Use `gh`/`glab` CLI instead of fetching URLs |
| `pull-requests.md` | PR workflow: study templates, preview before submit |
| `ripgrep.md` | Prefer `rg` over `grep` |
| `skills-cli.md` | Run skill commands from skill directory |
| `typescript.md` | TypeScript naming, type safety, imports, async |

## Development

```bash
bun install
bun run check
bun run lint
```

## License

MIT
