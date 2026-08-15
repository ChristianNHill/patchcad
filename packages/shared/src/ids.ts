/**
 * Branded ID types. At runtime these are plain strings; the brand prevents
 * accidentally passing a NodeId where a JobId is expected.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
export type JobId = Brand<string, "JobId">;

export const projectId = (s: string) => s as ProjectId;
export const nodeId = (s: string) => s as NodeId;
export const edgeId = (s: string) => s as EdgeId;
export const jobId = (s: string) => s as JobId;

let counter = 0;
/** Sortable, collision-resistant id: `<prefix>_<ts36>_<seq><rand>` */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  const ts = Date.now().toString(36);
  const seq = counter.toString(36).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${seq}${rand}`;
}
