/**
 * signal_completion - Custom Claude Code tool for structured completion signaling.
 *
 * Skills call this tool as their FINAL action to report outcomes.
 * Miranda watches for `tool_execution_end` events where `toolName === "signal_completion"`
 * and extracts the structured payload from the result.
 *
 * This is a pass-through tool - it validates the schema and returns the data.
 * No side effects, works standalone (when run outside Miranda context).
 */

// No type import needed - the loader casts `module.default as CustomToolFactory`
const factory = ({ typebox: { Type } }: { typebox: typeof import("@sinclair/typebox") }) => ({
  name: "signal_completion",
  label: "Signal Completion",

  description: `Signal task completion to the orchestrator. Call this as your FINAL action when a task is done.

Status values:
- "success": Task completed successfully. Include the PR URL in the "pr" field if applicable.
- "error": Unrecoverable failure. Include the reason in the "error" field.
- "blocked": Needs human decision. Include the reason in the "blocker" field.

Use the optional "message" field for a freeform summary of what was accomplished.

The orchestrator reads the structured result from this tool call. If not running under an orchestrator, this just returns a confirmation message.`,

  parameters: Type.Object({
    status: Type.Union([
      Type.Literal("success"),
      Type.Literal("error"),
      Type.Literal("blocked"),
    ], { description: "Completion status" }),
    pr: Type.Optional(Type.String({ description: "PR URL (for success status when applicable)" })),
    error: Type.Optional(Type.String({ description: "Error message (required for error status)" })),
    blocker: Type.Optional(Type.String({ description: "Blocker reason (required for blocked status)" })),
    message: Type.Optional(Type.String({ description: "Freeform summary of what was accomplished" })),
  }),

  async execute(_toolCallId, params) {
    // Build human-readable summary for the agent
    const parts: string[] = [`Status: ${params.status}`];
    if (params.pr) parts.push(`PR: ${params.pr}`);
    if (params.message) parts.push(`Message: ${params.message}`);
    if (params.error) parts.push(`Error: ${params.error}`);
    if (params.blocker) parts.push(`Blocker: ${params.blocker}`);

    // The structured data goes in `details` - Miranda reads this from the RPC event.
    // The `content` is what the agent sees as the tool result.
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: params,
    };
  },
});

export default factory;
