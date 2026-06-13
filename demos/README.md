# Demo Recordings

Automated terminal recordings for dot-pi extensions using [asciinema](https://asciinema.org) and [expect](https://linux.die.net/man/1/expect).

## Prerequisites

```bash
brew install asciinema expect
```

## Recording

Record all demos:

```bash
./record-all.sh
```

Or record a single demo:

```bash
expect tapes/codesearch.expect
```

## Tapes

| Tape                 | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `codesearch.expect`  | Search GitHub code for useEffect cleanup patterns      |
| `lsp.expect`         | Go to definition using LSP extension                   |
| `question.expect`    | Interactive question with selectable options           |
| `tutor-smoke.expect` | Smoke-test optional `/tutor` command without recording |
| `webfetch.expect`    | Fetch and summarize nodejs.org                         |
| `websearch.expect`   | Search the web for Node.js 24 features                 |

## Playback

```bash
asciinema play recordings/codesearch.cast
```

## Upload

Upload all recordings:

```bash
./upload-all.sh
```

Or upload a single recording:

```bash
asciinema upload recordings/codesearch.cast
```

Then embed in README with:

```markdown
[![asciicast](https://asciinema.org/a/YOUR_ID.svg)](https://asciinema.org/a/YOUR_ID)
```
