# Changelog

## Unreleased

### Fixed

- Command Code models now report the context window upstream advertises, instead of falling back to the 128K default before the first catalog refresh.
- Command Code catalog refreshes now persist through pi's model store, keep the last good catalog when a refresh fails or is aborted, and no longer return an empty list when no credential resolves.

## 0.2.9 - 2026-08-30

### Fixed

- Hardened web search requests against invalid Exa filters, dates, output schemas, and parameter ranges.
- Improved multiline tool output rendering to prevent widget layout artifacts from embedded newlines and carriage returns.
