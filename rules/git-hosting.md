Never `fetch` GitHub/GitLab URLs — use `gh` / `glab` CLI.

MR/PR review comments need line context:
```bash
# GitLab
glab api projects/:id/merge_requests/123/discussions | \
  jq -r '.[] | select(.notes[0].position != null) | .notes[] | "\(.position.new_path):\(.position.new_line) - \(.body)"'

# GitHub
gh api repos/{owner}/{repo}/pulls/123/comments | \
  jq -r '.[] | "\(.path):\(.line) - \(.body)"'
```
