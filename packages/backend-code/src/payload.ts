import { z } from "zod";

/** Domain payload for web-code contracts. */
export const CodeContractPayload = z.object({
  /** Import specifier, always `@nodes/<node-id>`. */
  module: z.string(),
  exports: z
    .array(
      z.object({
        name: z.string(),
        exportKind: z.enum(["component", "hook", "function", "const"]),
        signature: z.string().default(""),
      }),
    )
    .min(1),
  /** TypeScript source text for the props type, if the main export takes props. */
  propsType: z.string().optional(),
  /** Each must be encoded in the node's generated smoke test. */
  postconditions: z.array(z.string()).default([]),
});
export type CodeContractPayload = z.infer<typeof CodeContractPayload>;
