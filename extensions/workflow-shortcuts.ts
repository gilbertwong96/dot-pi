import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function buildNextPrompt(args: string): string {
  const count = args.trim();
  const countInstruction = count
    ? `List exactly ${count} next steps.`
    : "List exactly 7 next steps.";

  return `State briefly. ${countInstruction} End with best action.`;
}

export function buildRecapPrompt(args: string): string {
  const focus = args.trim();

  return `Reconstruct the global context from this conversation so you and I are both re-oriented. Do not over-focus on the last turn.

Cover:

1. Original goal / plan
2. Current state
3. Important decisions
4. Open threads
5. Drift or plan changes
6. Best next action

Keep it concise.${focus ? ` Focus on: ${focus}` : ""}`;
}

export default function workflowShortcuts(pi: ExtensionAPI) {
  pi.registerCommand("next", {
    description: "State briefly, list next steps, and pick the best action",
    async handler(args) {
      pi.sendUserMessage(buildNextPrompt(args));
    },
  });

  pi.registerCommand("recap", {
    description: "Reconstruct global context and identify the best next action",
    async handler(args) {
      pi.sendUserMessage(buildRecapPrompt(args));
    },
  });
}
