/**
 * A worked plan for the architect: examples/cad-clamp's plate and bracket as
 * the architect would emit them now — nodes, contracts, edges and one joint,
 * no code and no hardware. A plan is easier to imitate than to assemble from
 * forty rules, and once its joint is expanded it passes every CAD plan lint
 * (asserted by test). Param descriptions, visualChecks and the rationale are
 * added here because the guidance demands them and a few-shot that skips
 * them teaches skipping them.
 *
 * Rendered once at module load, so the architect system prompt stays
 * byte-identical across calls and prefix-cacheable.
 */
export const WORKED_PLAN = {
  "nodes": [
    {
      "id": "base-plate",
      "kind": "part",
      "title": "Base plate",
      "spec": "Rectangular mounting plate the bracket bolts down onto.",
      "contract": {
        "name": "Base plate",
        "summary": "60×40×5 plate; the bracket sits on its top face.",
        "params": [
          {
            "type": "number",
            "name": "width",
            "description": "plate length along x",
            "default": 60,
            "min": 30,
            "max": 120
          },
          {
            "type": "number",
            "name": "depth",
            "description": "plate width along y",
            "default": 40,
            "min": 20,
            "max": 80
          },
          {
            "type": "number",
            "name": "thickness",
            "description": "how thick the plate prints",
            "default": 5,
            "min": 2.5,
            "max": 10
          }
        ],
        "provides": [
          {
            "key": "bracket_face",
            "type": "FLAT_FACE",
            "description": "where the bracket's base leg sits"
          }
        ],
        "requires": [],
        "payload": {
          "units": "mm",
          "process": {
            "kind": "FDM",
            "minWall": 1.2,
            "nozzle": 0.4
          },
          "paramBindings": {},
          "ports": [
            {
              "name": "bracket_face",
              "type": "FLAT_FACE",
              "pose": {
                "origin": [
                  0,
                  0,
                  "param(base-plate.thickness) / 2"
                ],
                "zAxis": [
                  0,
                  0,
                  1
                ],
                "xAxis": [
                  1,
                  0,
                  0
                ]
              },
              "params": {
                "size": 20
              }
            }
          ],
          "envelope": {
            "volumes": [
              {
                "kind": "box",
                "pose": {
                  "origin": [
                    0,
                    0,
                    0
                  ],
                  "zAxis": [
                    0,
                    0,
                    1
                  ],
                  "xAxis": [
                    1,
                    0,
                    0
                  ]
                },
                "dims": [
                  "param(base-plate.width)",
                  "param(base-plate.depth)",
                  "param(base-plate.thickness)"
                ]
              }
            ],
            "clearance": 0.4
          },
          "visualChecks": [
            "Is the part a flat rectangular plate?",
            "Is there a hole through the middle of the plate?"
          ]
        }
      }
    },
    {
      "id": "l-bracket",
      "kind": "part",
      "title": "L-bracket",
      "spec": "L-bracket held to the plate through its base leg.",
      "contract": {
        "name": "L-bracket",
        "summary": "30 mm L-bracket; its base leg sits on the plate.",
        "params": [
          {
            "type": "number",
            "name": "width",
            "description": "bracket width along x",
            "default": 30,
            "min": 15,
            "max": 60
          },
          {
            "type": "number",
            "name": "depth",
            "description": "how far the base leg reaches",
            "default": 30,
            "min": 15,
            "max": 60
          },
          {
            "type": "number",
            "name": "thickness",
            "description": "wall thickness of both legs",
            "default": 6,
            "min": 5,
            "max": 12
          },
          {
            "type": "number",
            "name": "height",
            "description": "how tall the upright leg stands",
            "default": 30,
            "min": 15,
            "max": 60
          }
        ],
        "provides": [],
        "requires": [
          {
            "key": "base_face",
            "type": "FLAT_FACE",
            "description": "underside of the base leg, on the plate"
          }
        ],
        "payload": {
          "units": "mm",
          "process": {
            "kind": "FDM",
            "minWall": 1.2,
            "nozzle": 0.4
          },
          "paramBindings": {},
          "ports": [
            {
              "name": "base_face",
              "type": "FLAT_FACE",
              "pose": {
                "origin": [
                  0,
                  "-(param(l-bracket.depth) / 2) + 10",
                  0
                ],
                "zAxis": [
                  0,
                  0,
                  -1
                ],
                "xAxis": [
                  1,
                  0,
                  0
                ]
              },
              "params": {
                "size": 14
              }
            }
          ],
          "envelope": {
            "volumes": [
              {
                "kind": "box",
                "pose": {
                  "origin": [
                    0,
                    0,
                    "param(l-bracket.thickness) / 2"
                  ],
                  "zAxis": [
                    0,
                    0,
                    1
                  ],
                  "xAxis": [
                    1,
                    0,
                    0
                  ]
                },
                "dims": [
                  "param(l-bracket.width)",
                  "param(l-bracket.depth)",
                  "param(l-bracket.thickness)"
                ]
              },
              {
                "kind": "box",
                "pose": {
                  "origin": [
                    0,
                    "param(l-bracket.depth) / 2 - param(l-bracket.thickness) / 2",
                    "param(l-bracket.height) / 2"
                  ],
                  "zAxis": [
                    0,
                    0,
                    1
                  ],
                  "xAxis": [
                    1,
                    0,
                    0
                  ]
                },
                "dims": [
                  "param(l-bracket.width)",
                  "param(l-bracket.thickness)",
                  "param(l-bracket.height)"
                ]
              }
            ],
            "clearance": 0.4
          },
          "visualChecks": [
            "Is the part an L shape with one horizontal and one vertical leg?",
            "Is there a hole through the horizontal leg?"
          ]
        }
      }
    }
  ],
  "edges": [
    {
      "from": "base-plate",
      "fromPort": "bracket_face",
      "to": "l-bracket",
      "toPort": "base_face"
    }
  ],
  "joints": [
    {
      "id": "bolt",
      "a": {
        "node": "base-plate",
        "port": "bracket_face"
      },
      "b": {
        "node": "l-bracket",
        "port": "base_face"
      },
      "intent": "removable",
      "motion": "fixed",
      "load": "light",
      "access": "both_sides",
      "count": 1,
      "wallA": "param(base-plate.thickness)",
      "wallB": "param(l-bracket.thickness)"
    }
  ],
  "entryNodeId": "base-plate",
  "rationale": "Two printed parts because the bracket must come off the plate. One removable joint holds them: the rules pick the screw and what it threads into, and cut the holes in both parts, so resizing either part re-picks the hardware instead of leaving a stale screw.",
  "design": "Plain functional hardware: crisp edges with a small 0.5 mm chamfer on outside edges, no decoration, walls that read sturdy rather than minimal."
};

export const WORKED_PLAN_GOAL = "bolt an L-bracket to a base plate so it can be taken off";
