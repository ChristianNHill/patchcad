/**
 * Phase 4.6 end to end, against a RUNNING server (and its kernel): import a
 * 120×40×30 block cut in two with joints "auto", wait for the cook, and check
 * that the cut became real hardware — a screw and an insert node from the
 * registry, pockets cut into the imported pieces by their deterministic code —
 * that every node passed its gates, and that the BOM lists what to buy.
 * Zero LLM calls: every node in this graph is deterministic.
 *
 *   PATCHCAD_API=http://127.0.0.1:4100 pnpm exec tsx src/import-joints-smoke.ts
 *
 * It creates (and opens) a project under projects/, like any import.
 */
const API = process.env.PATCHCAD_API ?? "http://127.0.0.1:4100";

/** An ASCII STL box, outward normals, mm. */
function boxStl([dx, dy, dz]: [number, number, number]): string {
  const v = (i: number) => [(i & 1 ? 1 : -1) * dx / 2, (i & 2 ? 1 : -1) * dy / 2, (i & 4 ? 1 : -1) * dz / 2];
  // Two triangles per face, counter-clockwise seen from outside.
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const facet = (a: number, b: number, c: number) =>
    `facet normal 0 0 0\n outer loop\n${[a, b, c].map((i) => `  vertex ${v(i).join(" ")}`).join("\n")}\n endloop\nendfacet`;
  return `solid box\n${quads.flatMap(([a, b, c, d]) => [facet(a!, b!, c!), facet(a!, c!, d!)]).join("\n")}\nendsolid box\n`;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${res.url}: ${res.status} ${body.error ?? ""}`);
  return body;
}

type GraphNode = { id: string; kind: string; status: string; artifact: { code: string } | null; statusDetail?: { stage?: string; message?: string } };
type Graph = { nodes: Record<string, GraphNode>; joints: { id: string; intent: string; note?: string }[] };

async function main() {
  const imported = await json<{ ok: boolean; pieces: number; joints: number; notes: string[] }>(
    await fetch(`${API}/api/project/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "joint-block.stl", dataB64: Buffer.from(boxStl([120, 40, 30])).toString("base64"), pieces: 2, joints: "auto", thread: "M3" }),
    }),
  );
  check("import splits the block in two with one joint", imported.pieces === 2 && imported.joints === 1, JSON.stringify(imported));

  // Settled = no node cooking for 5 polls in a row: the assembly check (G5)
  // runs after the cook and can still move a ready part to error_contract.
  let graph: Graph | null = null;
  for (let i = 0, still = 0; i < 180 && still < 5; i++) {
    graph = (await json<{ graph: Graph }>(await fetch(`${API}/api/project`))).graph;
    const settled = Object.values(graph.nodes).every((n) => n.status === "ready" || n.status.startsWith("error"));
    still = settled ? still + 1 : 0;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const nodes = Object.values(graph!.nodes);
  const kinds = nodes.map((n) => n.kind);
  check("the joint minted a fastener and an insert", kinds.includes("fastener") && kinds.includes("insert"), kinds.join(", "));
  check("the joint is a fastened one", graph!.joints[0]?.intent === "removable", JSON.stringify(graph!.joints));
  const pieces = nodes.filter((n) => n.kind === "imported");
  check("both pieces cut their joint features deterministically",
    pieces.length === 2 && pieces.every((n) => n.artifact?.code.includes("cut_joints(")), pieces.map((n) => n.artifact?.code.slice(0, 80)).join(" | "));
  const failed = nodes.filter((n) => n.status !== "ready");
  check("every node passed its gates, G5 included", failed.length === 0,
    failed.map((n) => `${n.id} ${n.status} ${n.statusDetail?.stage ?? ""}: ${n.statusDetail?.message?.slice(0, 300) ?? ""}`).join("\n"));

  const bom = await json<{ buy: { sku: string; qty: number; description: string }[] }>(await fetch(`${API}/api/project/bom?format=json`));
  const screws = bom.buy.filter((r) => /ISO7380|ISO4762|screw/i.test(`${r.sku} ${r.description}`));
  const inserts = bom.buy.filter((r) => /insert|heat/i.test(`${r.sku} ${r.description}`));
  check("the BOM lists screws and inserts", screws.length > 0 && inserts.length > 0, JSON.stringify(bom.buy));
  check("one screw per joint site", screws.reduce((t, r) => t + r.qty, 0) === 2 && inserts.reduce((t, r) => t + r.qty, 0) === 2,
    bom.buy.map((r) => `${r.sku}×${r.qty}`).join(", "));

  if (failures.length) {
    console.log(`${failures.length} FAILURE(S)`);
    process.exit(1);
  }
  console.log("all checks passed");
}

void main();
