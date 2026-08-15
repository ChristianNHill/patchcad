import type { GraphDoc, NodeRecord, NodeStatus, ParamValue, EngineEvent } from "@patchcad/shared";
import type { EventBus } from "../events.js";
import { contractHash } from "./diff.js";
import type { ContractView } from "../backend.js";

/**
 * Single-writer store for one project's GraphDoc. Every mutation goes
 * through applyOp so rev bumps, contract hashes, and persistence stay
 * consistent. (Op log / undo lands in M5.)
 */

export type PersistFn = (graph: GraphDoc) => Promise<void>;

const STATUS_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  planned: ["queued", "cancelled"],
  queued: ["generating", "building", "cancelled"],
  generating: ["building", "repairing", "error_code", "error_contract", "cancelled"],
  building: ["verifying", "repairing", "error_code", "error_contract", "cancelled"],
  verifying: ["ready", "repairing", "error_code", "error_contract", "cancelled"],
  repairing: ["generating", "error_code", "error_contract", "cancelled"],
  ready: ["dirty", "queued", "cancelled"],
  dirty: ["queued", "cancelled"],
  error_code: ["queued", "cancelled"],
  error_contract: ["queued", "cancelled"],
  cancelled: ["queued"],
};

export class GraphStore {
  private graph: GraphDoc;
  private persist: PersistFn;
  private bus: EventBus;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(graph: GraphDoc, bus: EventBus, persist: PersistFn) {
    this.graph = graph;
    this.bus = bus;
    this.persist = persist;
    this.recomputeAllContractHashes();
  }

  get doc(): GraphDoc {
    return this.graph;
  }

  node(nodeId: string): NodeRecord {
    const n = this.graph.nodes[nodeId];
    if (!n) throw new Error(`unknown node: ${nodeId}`);
    return n;
  }

  /** All mutations funnel through here. */
  applyOp(mutate: (graph: GraphDoc) => void, opts?: { immediate?: boolean }): void {
    mutate(this.graph);
    this.graph.rev += 1;
    this.schedulePersist(opts?.immediate ?? false);
  }

  /** Swap in an entirely new graph (plan approval). */
  replace(graph: GraphDoc): void {
    this.graph = graph;
    this.recomputeAllContractHashes();
    this.graph.rev += 1;
    this.schedulePersist(true);
    this.emit({ type: "graph:replaced", projectId: this.graph.id, graph: this.graph });
  }

  setStatus(nodeId: string, status: NodeStatus, detail?: NodeRecord["statusDetail"]): void {
    const node = this.node(nodeId);
    const allowed = STATUS_TRANSITIONS[node.status];
    if (!allowed.includes(status) && node.status !== status) {
      throw new Error(`illegal status transition ${node.status} → ${status} on ${nodeId}`);
    }
    this.applyOp((g) => {
      const n = g.nodes[nodeId]!;
      n.status = status;
      n.statusDetail = detail;
    });
    this.emit({ type: "node:status", projectId: this.graph.id, nodeId, status, detail });
  }

  setParams(nodeId: string, params: Record<string, ParamValue>): void {
    this.applyOp((g) => {
      const n = g.nodes[nodeId]!;
      n.params = { ...n.params, ...params };
    });
  }

  recomputeAllContractHashes(): void {
    for (const node of Object.values(this.graph.nodes)) {
      node.contract.hash = contractHash(node.contract);
    }
  }

  /** Hermetic neighbor views for a node's generator — contracts only. */
  contractViews(nodeId: string): { upstream: ContractView[]; downstream: ContractView[] } {
    const upstream = new Map<string, ContractView>();
    const downstream = new Map<string, ContractView>();
    for (const edge of this.graph.edges) {
      if (edge.to === nodeId) {
        const view = upstream.get(edge.from) ?? this.makeView(edge.from, "upstream");
        view.viaPorts.push({ fromPort: edge.fromPort, toPort: edge.toPort });
        upstream.set(edge.from, view);
      }
      if (edge.from === nodeId) {
        const view = downstream.get(edge.to) ?? this.makeView(edge.to, "downstream");
        view.viaPorts.push({ fromPort: edge.fromPort, toPort: edge.toPort });
        downstream.set(edge.to, view);
      }
    }
    return { upstream: [...upstream.values()], downstream: [...downstream.values()] };
  }

  private makeView(neighborId: string, direction: "upstream" | "downstream"): ContractView {
    const c = this.node(neighborId).contract;
    return {
      nodeId: neighborId,
      direction,
      viaPorts: [],
      contract: {
        name: c.name,
        summary: c.summary,
        params: c.params,
        provides: c.provides,
        requires: c.requires,
        payload: c.payload,
      },
    };
  }

  emit(event: EngineEvent): void {
    this.bus.emit(event);
  }

  private schedulePersist(immediate: boolean): void {
    if (immediate) {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.persist(this.graph);
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist(this.graph);
    }, 500);
  }
}
