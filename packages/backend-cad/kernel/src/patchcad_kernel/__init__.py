"""PatchCAD geometry kernel: executes generated build123d node code in
isolated warm workers, gates the result (G0 static scan, G1 execute,
G2 validity), and emits GLB meshes + measurements, content-addressed."""
