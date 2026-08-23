import { z } from "zod";
import { NodeStatus, CookFailure, GraphDoc } from "./graph.js";

/**
 * Engine → UI event stream (relayed over WebSocket by the server).
 * Every event carries the project id so one socket can serve many projects.
 */

export const EngineEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("graph:replaced"),
    projectId: z.string(),
    graph: GraphDoc,
  }),
  z.object({
    type: z.literal("node:status"),
    projectId: z.string(),
    nodeId: z.string(),
    status: NodeStatus,
    detail: CookFailure.optional(),
  }),
  z.object({
    /** Where the architect is in a plan. The plan call is the longest single
     *  operation in the product and used to show only a button reading
     *  "planning…" for its whole duration. */
    type: z.literal("plan:phase"),
    projectId: z.string(),
    phase: z.enum(["drafting", "checking", "repairing", "done", "failed"]),
    detail: z.string().default(""),
  }),
  z.object({
    type: z.literal("node:committed"),
    projectId: z.string(),
    nodeId: z.string(),
    version: z.number(),
  }),
  z.object({
    type: z.literal("job:log"),
    projectId: z.string(),
    nodeId: z.string(),
    line: z.string(),
  }),
  z.object({
    type: z.literal("checker:status"),
    projectId: z.string(),
    status: z.enum(["clean", "checking", "failing"]),
    problems: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("cost:update"),
    projectId: z.string(),
    nodeId: z.string().optional(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    usd: z.number(),
  }),
  z.object({
    type: z.literal("preview:reload"),
    projectId: z.string(),
    nodeId: z.string().optional(),
  }),
  z.object({
    type: z.literal("undo:stack"),
    projectId: z.string(),
    depth: z.number(),
    /** Label of the checkpoint that POST /undo would restore next ("" when empty). */
    label: z.string(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
