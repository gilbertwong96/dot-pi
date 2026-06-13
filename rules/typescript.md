---
paths: "**/*.{ts,tsx}"
---

## TypeScript Rules

### Naming Conventions

- PascalCase for interfaces, types, classes, components
- camelCase for functions, variables, methods
- SCREAMING_SNAKE_CASE for constants
- kebab-case for file names

### Type Safety

- NO `any` without explicit justification comment
- NO `@ts-ignore` or `@ts-expect-error` without explanation
- Do NOT fix type errors by slapping `unknown` everywhere - fix the actual types
- Omit explicit return types when easily inferred, unless the codebase already uses explicit types consistently
- Prefer `value?: string` over `value: string | undefined` unless the codebase already uses the latter consistently

### Imports

- Group imports: external → internal → relative
- Use named exports over default exports
- No circular dependencies

### Async/Await

- Always handle promise rejections
- Use try/catch for async operations
- Avoid floating promises (unhandled)
