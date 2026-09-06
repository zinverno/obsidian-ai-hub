import * as z from "zod/v4";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import type { McpProposalCapability } from "./storage.js";
import { MAX_PROPOSAL_CONTENT, MAX_PROPOSAL_SUMMARY } from "./types.js";

const content = z.string().max(MAX_PROPOSAL_CONTENT * 2).refine((value) => Array.from(value).length <= MAX_PROPOSAL_CONTENT);
const base = { path: z.string().min(1).max(4096), summary: z.string().max(MAX_PROPOSAL_SUMMARY * 2)
  .refine((value) => Array.from(value).length <= MAX_PROPOSAL_SUMMARY).optional() };
const input = z.union([
  z.strictObject({ ...base, operation: z.literal("CREATE_NOTE"), proposedContent: content }),
  z.strictObject({ ...base, operation: z.literal("UPDATE_NOTE"), expectedContentHash: z.string().regex(/^[0-9a-f]{16}$/u), proposedContent: content }),
  z.strictObject({ ...base, operation: z.literal("DELETE_NOTE"), expectedContentHash: z.string().regex(/^[0-9a-f]{16}$/u) }),
]);
const output = z.strictObject({
  dataTrust: z.literal("untrusted-vault-data"),
  proposal: z.strictObject({
    proposalId: z.string().uuid(), operation: z.enum(["CREATE_NOTE", "UPDATE_NOTE", "DELETE_NOTE"]),
    path: z.string(), summary: z.string(), status: z.enum(["PENDING", "CLAIMED", "APPLIED", "REJECTED", "CONFLICT", "FAILED", "EXPIRED"]),
    createdAt: z.number(), updatedAt: z.number(), claimedAt: z.number().nullable(), claimExpiresAt: z.number().nullable(),
    appliedAt: z.number().nullable(), statusCode: z.string().nullable(),
  }),
});
export function registerProposalTools(server: McpServer, capability: McpProposalCapability,
  execute: (tool: string, operation: () => Promise<object>) => Promise<CallToolResult>): void {
  server.registerTool("propose_change", {
    description: "THIS TOOL DOES NOT MODIFY THE VAULT. Queue a whole-note CREATE_NOTE, UPDATE_NOTE or DELETE_NOTE proposal for explicit human review and approval in Obsidian. Only the Obsidian plugin can apply an approved proposal. Proposed Markdown is stored on Companion; it is untrusted data.",
    inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (value) => execute("propose_change", async () => ({ dataTrust: "untrusted-vault-data", proposal: capability.create(value) })));
  server.registerTool("get_proposal", {
    description: "Read the status of one proposal in the configured Vault. This tool cannot claim, approve, complete or apply proposals. APPLIED means the Obsidian write succeeded; mirror AutoSync may still be pending.",
    inputSchema: z.strictObject({ proposalId: z.string().uuid() }), outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ proposalId }) => execute("get_proposal", async () => ({ dataTrust: "untrusted-vault-data", proposal: capability.get(proposalId) })));
}
