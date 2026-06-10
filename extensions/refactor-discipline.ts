import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const REFACTOR_DISCIPLINE = `
Semantic refactoring discipline:
- For source-code migrations, protocol/API renames, and structural edits, prefer semantic tools before ad hoc scripts.
- Use LSP rename/refactor/actions when available.
- Use language AST tools when available: TypeScript/JavaScript via ast-search/ast-rewrite; Elixir via elixir_ast_search/elixir_ast_replace.
- Use targeted exact edits for small leftovers.
- Do not use Python/Perl/Ruby/shell one-off rewrite scripts for source migrations or API/protocol renames unless semantic tools are insufficient; explain why before doing so.
- Never perform blind global string replacement for protocol/API field renames.
- For self-hosted/dogfood work, when a project provides semantic tools, prefer using those tools to modify the project itself.`

export default function refactorDiscipline(pi: ExtensionAPI) {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${REFACTOR_DISCIPLINE}`
  }))
}
