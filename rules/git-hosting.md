Never `fetch` GitHub/GitLab/Azure DevOps URLs — use `gh` / `glab` / `az repos` CLI.

MR/PR review comments need line context:

```bash
# GitLab
glab api projects/:id/merge_requests/123/discussions | \
  jq -r '.[] | select(.notes[0].position != null) | .notes[] | "\(.position.new_path):\(.position.new_line) - \(.body)"'

# GitHub
gh api repos/{owner}/{repo}/pulls/123/comments | \
  jq -r '.[] | "\(.path):\(.line) - \(.body)"'

# Azure DevOps
az repos pr policy list --id 123 | \
  jq -r

az repos pr reviewer list --id 123 | \
  jq -r

az repos pr work-item list --id 123 | \
  jq -r

az repos import create \
  --git-source-url https://github.com/{owner}/{repo}.git \
  --repository {target-repo}
```
