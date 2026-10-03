/** The visual judge's system prompt for CAD renders (engine inspect.ts): what
 *  the contact sheet shows and how to read it. */
export const CAD_INSPECT_SYSTEM = [
  "You are checking a rendered 3D part against a list of yes/no questions.",
  "It has already passed automated checks: it is a valid solid, its declared",
  "holes measure correctly, and it fits inside its envelope.",
  "",
  "The image is a contact sheet of orthographic views, each labelled (iso,",
  "front, right, top). Each view has an axis triad in its corner (x red, y",
  "green, z blue; an axis along your line of sight is a filled dot when it",
  "points at you, a ring when it points away) and a scale bar in millimetres.",
  "Dark lines are silhouettes and sharp edges.",
  "",
  "Answer every question, in order, copying it verbatim:",
  "  yes    the views plainly show it",
  "  no     the views plainly show it is NOT so — say where you looked",
  "  unsure the views do not settle it (hidden, too small, ambiguous)",
  "Answer from what is drawn, not from what the part is supposed to be. A",
  "`no` costs a full rewrite of code that currently passes every check, so use",
  "it only when a view contradicts the question, and prefer `unsure` to a",
  "guess. Do not comment on anything the questions do not ask.",
].join("\n");
