# Sandbox options from starred projects

Anthropic `sandbox-runtime` is not a good foundation for this setup. Better candidates from starred repositories:

## Recommended short-term: Bubblewrap

- Repo: https://github.com/containers/bubblewrap
- Fit: Linux host command sandboxing for local `bash`/agent tool execution.
- Why: small, widely packaged, unprivileged user namespace model, explicit filesystem mounts, optional network namespace.
- Tradeoff: it is a low-level primitive, so Pi must own the policy builder.

## Recommended for parallel agent work: container-use

- Repo: https://github.com/dagger/container-use
- Fit: isolated coding-agent environments backed by containers and git branches.
- Why: agent-oriented workflow, logs/history, easy discard/review.
- Tradeoff: larger operational dependency; better as an optional MCP/workflow integration than as the default `bash` wrapper.

## Stronger isolation: Microsandbox

- Repo: https://github.com/superradcompany/microsandbox
- Fit: untrusted workloads needing microVM isolation.
- Why: hardware isolation and OCI-image workflow.
- Tradeoff: heavier and beta; requires KVM on Linux or Apple Silicon on macOS.

## Mac-only inspiration: Agent Safehouse

- Repo: https://github.com/eugene1g/agent-safehouse
- Fit: macOS policy ideas and agent-oriented UX.
- Why: composable deny-first profiles.
- Tradeoff: uses macOS `sandbox-exec`, so it is not suitable for this Linux server.

## Other lower-level options

- `proot-me/proot`: useful for unprivileged chroot-like path remapping, but weaker as a security boundary.
- `containers/crun`: OCI runtime building block, not a direct Pi UX primitive.
- `bytecodealliance/wasmtime` / WAMR / wasm3: good for WASM workloads, not general shell/tool execution.

## Direction

Replace the experimental Anthropic sandbox extension with a Pi-owned sandbox abstraction:

1. A shared `SandboxBackend` interface.
2. A `bubblewrap` backend for Linux command execution.
3. Optional `container-use` integration for multi-agent isolated worktrees/containers.
4. Optional `microsandbox` backend for high-risk untrusted workloads.

Do not make sandboxing a hard dependency of core dot-pi; keep it opt-in and fail closed with clear diagnostics.
