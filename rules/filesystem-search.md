# Filesystem Search Safety

Do not accidentally scan large parts of the user's disk.

Default scope is the current project/repo only.

Forbidden without explicit user approval:

- `find / ...`
- `find ~ ...`
- `find /Users ...`
- `find /Volumes ...`
- broad `find .. ...` from outside the repo
- unbounded `du`, `ls`, `rg`, `grep`, `fd`, or shell globs over root, home, `/Users`, `/Volumes`, caches, backups, or mounted disks

Before any wider search, state the exact scope and ask for approval.

Use bounded searches instead:

```bash
find . -maxdepth 3 -type f -name '*.ts'
rg 'pattern' . --glob '!node_modules' --glob '!.git'
```
