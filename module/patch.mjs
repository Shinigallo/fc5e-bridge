export const ALLOW = [
  /^system\.attributes\.hp\.(value|temp|tempmax)$/,
  /^system\.attributes\.death\.(success|failure)$/,
  /^system\.attributes\.exhaustion$/,
  /^system\.attributes\.inspiration$/,
  /^system\.currency\.(pp|ep|gp|sp|cp)$/,
  /^items\.[^.]+\.system\.(quantity|equipped|attuned)$/,
  /^items\.[^.]+\.system\.preparation\.prepared$/,
];

/** Split a flat map of sheet paths into actor-level and item-level updates. */
export function splitPatch(patch) {
  const actorChanges = {};
  const itemChanges = {};
  for (const [path, value] of Object.entries(patch)) {
    if (!ALLOW.some(re => re.test(path))) throw new Error(`not allowed: ${path}`);
    if (typeof value !== "number" && typeof value !== "boolean") throw new Error(`bad value: ${path}`);
    const m = /^items\.([^.]+)\.(.+)$/.exec(path);
    if (m) (itemChanges[m[1]] ??= {})[m[2]] = value;
    else actorChanges[path] = value;
  }
  return { actorChanges, itemChanges };
}
