import path from "path";

const normalizedNodeModulesSegment = `${path.sep}node_modules${path.sep}`;

export function packageNameFromModulePath(id: string): string | null {
  const normalized = id.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  const idx = normalized.lastIndexOf(normalizedNodeModulesSegment);
  if (idx === -1) return null;

  const afterNodeModules = normalized.slice(
    idx + normalizedNodeModulesSegment.length,
  );
  const [first = "", second = ""] = afterNodeModules.split(path.sep);
  if (!first) return null;

  return first.startsWith("@") && second ? `${first}/${second}` : first;
}
