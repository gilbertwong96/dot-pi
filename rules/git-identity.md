# Git Identity

Never invent, override, or guess a git committer identity. When committing
(`git commit`, `git commit --amend`, `git rebase`, `git cherry-pick`,
author/committer rewrites, etc.):

- Do NOT pass `-c user.name=...` or `-c user.email=...` to git.
- Do NOT run `git config user.name` or `git config user.email` (local or
  global) to set, change, or "fix" identity for a commit.
- Use the identity already configured for the repo (repo-local → global
  `~/.gitconfig` → system). Do not change it just because the model name or
  provider name is different.
- If git refuses the commit due to missing identity, stop and ask the user
  to configure it. Never fall back to a placeholder like the model name,
  "LLM", "pi", the assistant name, or any made-up address.

Check the active identity before committing when unsure:

```bash
git config --get user.name
git config --get user.email
```