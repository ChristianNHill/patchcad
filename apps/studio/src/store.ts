import { create } from "zustand";
import type { Contract, EngineEvent, GraphDoc, NodeStatus, ParamValue } from "@patchcad/shared";
import { API, WS_API } from "./api";

export type PlanState =
  | { status: "idle" }
  | { status: "planning"; goal: string }
  | { status: "pending"; plan: GraphDoc; rationale: string; usd: number }
  | { status: "error"; message: string };

/** A T3 contract renegotiation awaiting user approval. */
export interface Proposal {
  nodeId: string;
  contract: Contract;
  spec: string;
  rationale: string;
  constraintsApplied: string[];
  dirtied: string[];
  notes: string[];
}

export interface ProjectEntry {
  dir: string;
  name: string;
  goal: string;
  nodes: number;
}

interface StudioState {
  graph: GraphDoc | null;
  previewUrl: string | null;
  selectedNodeId: string | null;
  selectedCode: string;
  statuses: Record<string, NodeStatus>;
  logs: string[];
  previewFrame: HTMLIFrameElement | null;
  planState: PlanState;
  checker: { status: "clean" | "checking" | "failing"; problems: string[] };
  proposal: Proposal | null;
  projectDir: string | null;
  projects: ProjectEntry[];
  projectPickerOpen: boolean;
  undo: { depth: number; label: string };
  /** Bumped whenever the CAD scene should refetch (commits, T0/T1 re-executes). */
  cadSceneRev: number;
  /** Per-node DfAM measurements (CADClamp-derived), filled by the viewport fetch. */
  printability: Record<string, { composite?: number; min_wall?: { thin_wall_p2_mm: number }; overhang?: { fail_area_fraction: number } }>;
  setPrintability: (p: StudioState["printability"]) => void;

  connect: () => Promise<void>;
  selectNode: (nodeId: string | null) => Promise<void>;
  setPreviewFrame: (el: HTMLIFrameElement | null) => void;
  pushParam: (nodeId: string, name: string, value: ParamValue) => void;
  sendInitialParams: () => void;
  plan: (goal: string, backend?: "web-code" | "cad") => Promise<void>;
  approvePlan: () => Promise<void>;
  discardPlan: () => Promise<void>;
  reprompt: (nodeId: string, message: string) => Promise<{ tier: "T2" | "T3"; reason: string }>;
  acceptProposal: () => Promise<void>;
  rejectProposal: () => Promise<void>;
  revert: (nodeId: string, version: number) => Promise<void>;
  updateContract: (nodeId: string, contract: unknown) => Promise<{ ok: boolean; error?: string }>;
  cookDirty: () => Promise<void>;
  loadProjects: () => Promise<void>;
  openProject: (dir: string) => Promise<void>;
  closeProject: () => Promise<void>;
  setProjectPickerOpen: (open: boolean) => void;
  undoLast: () => Promise<void>;
  /** Returns an error message, or null on success. */
  importCad: (file: File, opts: { pieces: number; joints: "none" | "holes" | "pegs"; thread: string }) => Promise<string | null>;
  /** Split an imported node into its natural pieces. Returns error or a notice. */
  segmentNode: (nodeId: string, joints: "none" | "holes" | "pegs") => Promise<string | null>;
}

const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** 1234 → "1.2k", 40 → "40". Token counts everywhere in the cost UI. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const useStudio = create<StudioState>((set, get) => ({
  graph: null,
  previewUrl: null,
  selectedNodeId: null,
  selectedCode: "",
  statuses: {},
  logs: [],
  previewFrame: null,
  planState: { status: "idle" },
  checker: { status: "clean", problems: [] },
  proposal: null,
  projectDir: null,
  projects: [],
  projectPickerOpen: false,
  undo: { depth: 0, label: "" },
  cadSceneRev: 0,
  printability: {},

  async connect() {
    const res = await fetch(`${API}/api/project`);
    const { graph, previewUrl, dir, undo } = (await res.json()) as {
      graph: GraphDoc;
      previewUrl: string;
      dir: string;
      undo?: { depth: number; label: string };
    };
    const statuses: Record<string, NodeStatus> = {};
    for (const n of Object.values(graph.nodes)) statuses[n.id] = n.status;
    set({ graph, previewUrl, statuses, projectDir: dir, undo: undo ?? { depth: 0, label: "" } });

    const ws = new WebSocket(`${WS_API}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as EngineEvent;
      if (event.type === "graph:replaced") {
        const st: Record<string, NodeStatus> = {};
        for (const n of Object.values(event.graph.nodes)) st[n.id] = n.status;
        // A replaced graph invalidates any server-side proposal.
        const switched = get().graph?.id !== event.graph.id;
        set({ graph: event.graph, statuses: st, ...(switched ? { proposal: null } : {}) });
      } else if (event.type === "node:status") {
        set((s) => ({ statuses: { ...s.statuses, [event.nodeId]: event.status } }));
      } else if (event.type === "job:log") {
        set((s) => ({ logs: [...s.logs.slice(-99), `[${event.nodeId}] ${event.line}`] }));
      } else if (event.type === "node:committed") {
        // Re-fetch the inspected code if the selected node just re-cooked.
        if (get().selectedNodeId === event.nodeId) void get().selectNode(event.nodeId);
        set((s) => ({ cadSceneRev: s.cadSceneRev + 1 }));
      } else if (event.type === "preview:reload") {
        set((s) => ({ cadSceneRev: s.cadSceneRev + 1 }));
      } else if (event.type === "checker:status") {
        set({ checker: { status: event.status, problems: event.problems } });
      } else if (event.type === "undo:stack") {
        set({ undo: { depth: event.depth, label: event.label } });
      } else if (event.type === "cost:update") {
        // Fold streamed usage into the local graph so totals stay live.
        set((s) => {
          if (!s.graph || !event.nodeId) return {};
          const node = s.graph.nodes[event.nodeId];
          if (!node) return {};
          node.cost = {
            calls: node.cost.calls + 1,
            inputTokens: node.cost.inputTokens + event.inputTokens,
            outputTokens: node.cost.outputTokens + event.outputTokens,
            usd: node.cost.usd + event.usd,
          };
          return { graph: { ...s.graph } };
        });
      }
    };
    ws.onclose = () => setTimeout(() => void get().connect(), 2000);

    // The preview iframe announces readiness; answer with the param snapshot.
    window.addEventListener("message", (e) => {
      const data = e.data as { type?: string; nodeId?: string; message?: string } | undefined;
      if (data?.type === "patchcad:preview:ready") get().sendInitialParams();
      if (data?.type === "patchcad:node:error") {
        set((s) => ({
          logs: [...s.logs.slice(-99), `[${data.nodeId}] crashed in preview: ${data.message}`],
        }));
      }
    });
  },

  async selectNode(nodeIdValue) {
    set({ selectedNodeId: nodeIdValue, selectedCode: "" });
    if (!nodeIdValue) return;
    const res = await fetch(`${API}/api/project/nodes/${nodeIdValue}/code`);
    if (res.ok) {
      const { code } = (await res.json()) as { code: string };
      set({ selectedCode: code });
    }
  },

  setPreviewFrame(el) {
    set({ previewFrame: el });
  },

  sendInitialParams() {
    const { graph, previewFrame } = get();
    if (!graph || !previewFrame?.contentWindow) return;
    const all: Record<string, Record<string, ParamValue>> = {};
    for (const node of Object.values(graph.nodes)) {
      const defaults: Record<string, ParamValue> = {};
      for (const p of node.contract.params) defaults[p.name] = p.default;
      all[node.id] = { ...defaults, ...node.params };
    }
    previewFrame.contentWindow.postMessage({ type: "patchcad:params:init", all }, "*");
  },

  async plan(goal, backend = "web-code") {
    set({ planState: { status: "planning", goal } });
    try {
      const res = await fetch(`${API}/api/project/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, backend }),
      });
      const data = (await res.json()) as {
        plan?: GraphDoc;
        rationale?: string;
        usage?: { usd: number };
        error?: string;
      };
      if (!res.ok || !data.plan) {
        set({ planState: { status: "error", message: data.error ?? `plan failed (${res.status})` } });
        return;
      }
      set({
        planState: {
          status: "pending",
          plan: data.plan,
          rationale: data.rationale ?? "",
          usd: data.usage?.usd ?? 0,
        },
      });
    } catch (err) {
      set({ planState: { status: "error", message: (err as Error).message } });
    }
  },

  async approvePlan() {
    const res = await fetch(`${API}/api/project/plan/approve`, { method: "POST" });
    if (res.ok) set({ planState: { status: "idle" }, selectedNodeId: null });
    // graph:replaced + node statuses arrive over the WS as the cook runs.
  },

  async discardPlan() {
    await fetch(`${API}/api/project/plan`, { method: "DELETE" });
    set({ planState: { status: "idle" } });
  },

  async reprompt(nodeIdValue, message) {
    const res = await fetch(`${API}/api/project/nodes/${nodeIdValue}/reprompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = (await res.json()) as {
      tier?: "T2" | "T3";
      reason?: string;
      proposal?: Proposal;
      error?: string;
    };
    if (!res.ok) {
      set((s) => ({ logs: [...s.logs.slice(-99), `[${nodeIdValue}] reprompt failed: ${data.error}`] }));
      return { tier: "T2", reason: data.error ?? "reprompt failed" };
    }
    if (data.tier === "T3" && data.proposal) set({ proposal: data.proposal });
    return { tier: data.tier ?? "T2", reason: data.reason ?? "" };
  },

  async acceptProposal() {
    const proposal = get().proposal;
    if (!proposal) return;
    set({ proposal: null });
    await fetch(`${API}/api/project/nodes/${proposal.nodeId}/proposal/accept`, { method: "POST" });
    // Statuses + committed versions stream over the WS as the wave cooks.
  },

  async rejectProposal() {
    const proposal = get().proposal;
    if (!proposal) return;
    set({ proposal: null });
    await fetch(`${API}/api/project/nodes/${proposal.nodeId}/proposal`, { method: "DELETE" });
  },

  async loadProjects() {
    const res = await fetch(`${API}/api/projects`);
    if (!res.ok) return;
    const data = (await res.json()) as { projects: ProjectEntry[]; active: string };
    set({ projects: data.projects, projectDir: data.active });
  },

  async openProject(dir) {
    const res = await fetch(`${API}/api/project/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (res.ok) {
      set({ projectDir: dir, projectPickerOpen: false, selectedNodeId: null, proposal: null });
      // graph:replaced arrives over the WS with the new project's nodes.
    }
  },

  async closeProject() {
    const res = await fetch(`${API}/api/project/close`, { method: "POST" });
    if (res.ok) {
      set({ projectDir: null, projectPickerOpen: false, selectedNodeId: null, proposal: null });
      // graph:replaced arrives over the WS with the empty graph -> welcome renders.
    }
  },

  setProjectPickerOpen(open) {
    if (open) void get().loadProjects();
    set({ projectPickerOpen: open });
  },

  async importCad(file, opts) {
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const res = await fetch(`${API}/api/project/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, dataB64: btoa(binary), ...opts }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; dir?: string };
    if (!res.ok || !data.ok) return data.error ?? `import failed (${res.status})`;
    set({ projectDir: data.dir ?? null, selectedNodeId: null, proposal: null });
    // graph:replaced + cook statuses stream over the WS.
    return null;
  },

  setPrintability(p) {
    set({ printability: p });
  },

  async segmentNode(nodeId, joints) {
    const res = await fetch(`${API}/api/project/nodes/${nodeId}/segment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joints }),
    });
    const data = (await res.json()) as { ok?: boolean; pieces?: number; message?: string; error?: string };
    if (!res.ok) return data.error ?? `split failed (${res.status})`;
    if (data.message) return data.message; // e.g. no natural pieces found
    set({ selectedNodeId: null });
    return null;
  },

  async undoLast() {
    const res = await fetch(`${API}/api/project/undo`, { method: "POST" });
    if (res.ok) {
      // graph:replaced arrives over the WS; a pending proposal is stale now.
      set({ proposal: null });
      const sel = get().selectedNodeId;
      if (sel) void get().selectNode(sel);
    } else {
      const data = (await res.json()) as { error?: string };
      set((s) => ({ logs: [...s.logs.slice(-99), `[undo] ${data.error ?? "failed"}`] }));
    }
  },

  async updateContract(nodeIdValue, contract) {
    const res = await fetch(`${API}/api/project/nodes/${nodeIdValue}/contract`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `update failed (${res.status})` };
    return { ok: true };
  },

  async cookDirty() {
    await fetch(`${API}/api/project/cook-dirty`, { method: "POST" });
  },

  async revert(nodeIdValue, version) {
    await fetch(`${API}/api/project/nodes/${nodeIdValue}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (get().selectedNodeId === nodeIdValue) void get().selectNode(nodeIdValue);
  },

  pushParam(nodeIdValue, name, value) {
    const { previewFrame, graph } = get();
    // T0 hot path: straight into the iframe, no server round-trip.
    previewFrame?.contentWindow?.postMessage(
      { type: "patchcad:params", nodeId: nodeIdValue, params: { [name]: value } },
      "*",
    );
    // Optimistic local update so controls stay in sync.
    if (graph) {
      const node = graph.nodes[nodeIdValue];
      if (node) node.params = { ...node.params, [name]: value };
      set({ graph: { ...graph } });
    }
    // Debounced persistence.
    const key = `${nodeIdValue}:${name}`;
    clearTimeout(persistTimers[key]);
    persistTimers[key] = setTimeout(() => {
      void fetch(`${API}/api/project/nodes/${nodeIdValue}/params`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { [name]: value } }),
      });
    }, 400);
  },
}));
