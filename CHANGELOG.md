# Changelog

## Unreleased

## 0.3.0 - 2026-11-04

### Breaking changes

- Requires Pi 1.5.0. Older Pi releases cannot load these extensions.

### Added

- Desktop automation is included in the `computer` extension: discover applications and windows, observe a window, and act on observed handles. The separate `pi-computer-use` companion is no longer offered by the installer.
- Added `maintainer-reply` and `pr-review` skills. Posting and other mutations stay behind explicit approval.

### Changed

- Computer actions use observed window and element handles. Webpage work stays with `agent-browser`.
- Compact computer discovery lists hide overflow until the result is expanded.
- The option picker and critic model dialog follow the configured select keys, including page up and page down.
- Creating a worktree fails unless `.worktrees/` is ignored.

### Fixed

- Custom turns no longer reset notify, critic, or oracle state as if they were new user prompts.
- Structured tool failures are reported to the model with `isError`.
- Commands whose output exceeds Pi's execution limit fail instead of returning a partial result.
- Web search structured results render as entries instead of raw text.

## 0.2.9 - 2026-08-30

### Fixed

- Hardened web search requests against invalid Exa filters, dates, output schemas, and parameter ranges.
- Improved multiline tool output rendering to prevent widget layout artifacts from embedded newlines and carriage returns.
