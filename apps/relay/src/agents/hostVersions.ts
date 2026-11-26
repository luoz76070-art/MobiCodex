/** Desktop hosts change their internals between builds. Verified builds passed the isolated checks; a newer build on
 * the same minor line is tried with every response still decoded, and the phone is told it is unverified. */
type Version = { core: [number, number, number]; pre: (string | number)[] };

export function parseVersion(value: string): Version | null {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".").map(part => /^\d+$/u.test(part) ? Number(part) : part) : [] };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The range forms plugin manifests use (`||` of space-separated comparators), prereleases included like the dsh
 * loader. Null when the range or version cannot be read. */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (!parsed || !range.trim()) return null;
  let satisfied = false;
  for (const alternative of range.split("||")) {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean);
    if (!comparators.length) return null;
    let all = true;
    for (const comparator of comparators) {
      const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(comparator)!, bound = parseVersion(match[2]!);
      if (!bound) return null;
      const order = compareVersions(parsed, bound);
      if (!(match[1] === ">=" ? order >= 0 : match[1] === "<=" ? order <= 0 : match[1] === ">" ? order > 0 : match[1] === "<" ? order < 0 : order === 0)) all = false;
    }
    if (all) satisfied = true;
  }
  return satisfied;
}

export type HostSupport = "verified" | "unverified" | null;
/** Same major.minor as a verified build and not older than the oldest one. */
export function hostSupport(version: string, verified: readonly string[]): HostSupport {
  if (verified.includes(version)) return "verified";
  const parsed = parseVersion(version), known = verified.map(parseVersion).filter((value): value is Version => value !== null);
  if (!parsed || !known.some(value => value.core[0] === parsed.core[0] && value.core[1] === parsed.core[1])) return null;
  const oldest = known.reduce((a, b) => compareVersions(a, b) <= 0 ? a : b);
  return compareVersions(parsed, oldest) >= 0 ? "unverified" : null;
}
