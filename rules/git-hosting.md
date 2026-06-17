Never `fetch` GitHub/GitLab/Azure DevOps URLs — use `gh` / `glab` / `ado` CLI.

MR/PR review comments need line context:

```bash
# GitLab
glab api projects/:id/merge_requests/123/discussions | \
  jq -r '.[] | select(.notes[0].position != null) | .notes[] | "\(.position.new_path):\(.position.new_line) - \(.body)"'

# GitHub
gh api repos/{owner}/{repo}/pulls/123/comments | \
  jq -r '.[] | "\(.path):\(.line) - \(.body)"'

# Azure DevOps
#
# List PRs in a repo
ado prs list PROJECT REPO --json | jq -r '.[].pullRequestId'
#
# Show a single PR (id, title, sourceRefName, targetRefName, reviewers, etc.)
ado prs show PROJECT REPO PR_ID --json | jq
#
# List review threads with line context
ado prs comments list PROJECT REPO PR_ID --all --json | \
  jq -r '.threads[] | "\(.threadContext.filePath):\(.threadContext.line) - \(.comments[0].content)"'
#
# View a PR's diff (3 modes: file list, --file PATH, --unified)
ado prs diff PROJECT REPO PR_ID --json
ado prs diff PROJECT REPO PR_ID --file path/to/file.ex
#
# List PR policies / reviewers / work-items
ado prs reviewers list PROJECT REPO PR_ID --json | jq
#
# Get PR status / completion info
ado prs show PROJECT REPO PR_ID --json | jq '.status, .mergeStatus'
#
# Add or update a review comment
ado prs comments add PROJECT REPO PR_ID --content "review body"
ado prs comments update PROJECT REPO PR_ID THREAD_ID COMMENT_ID --status closed
#
# Approve / complete a PR
ado prs approve PROJECT REPO PR_ID
ado prs complete PROJECT REPO PR_ID --merge-strategy squash
```

If `ado` doesn't cover a specific endpoint, fall back to direct REST API
calls via the Bearer/Basic auth header already in scope, e.g.:

```bash
# Get work items linked to a PR
ado workitems query PROJECT --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (...)"
```

Use `ado --json` for the high-level read paths above. The `ado` CLI is
self-contained, has no external dependency, works behind Zscaler, and
supports both AAD and MSA (personal `*.visualstudio.com`) orgs.
