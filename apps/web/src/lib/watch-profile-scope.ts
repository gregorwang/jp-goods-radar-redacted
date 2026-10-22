function parsedTerms(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizedAlternatives(groups: readonly string[]): Set<string> {
  return new Set(groups.flatMap((group) => group.split("|"))
    .map((term) => term.normalize("NFKC").trim().toLocaleLowerCase("ja"))
    .filter(Boolean));
}

function normalizedGroups(groups: readonly string[]): Set<string> {
  return new Set(groups.map((group) => [...normalizedAlternatives([group])].sort().join("|"))
    .filter(Boolean));
}

function sameGroups(left: readonly string[], right: readonly string[]): boolean {
  const leftGroups = normalizedGroups(left);
  const rightGroups = normalizedGroups(right);
  return leftGroups.size === rightGroups.size && [...leftGroups].every((group) => rightGroups.has(group));
}

/**
 * Adding negative terms only narrows a long-running keyword dossier, so it is
 * an in-place maintenance patch. Removing a negative term expands the result
 * universe and needs a silent baseline to avoid announcing old inventory as
 * new. Include-rule edits remain conservative because aliases inside one
 * required group can either widen or narrow the accepted universe.
 */
export function relevancePatchExpandsScope(input: {
  currentIncludeTermsJson: string;
  currentExcludeTermsJson: string;
  nextIncludeTerms?: readonly string[];
  nextExcludeTerms?: readonly string[];
}): boolean {
  const currentIncludes = parsedTerms(input.currentIncludeTermsJson);
  const currentExcludes = parsedTerms(input.currentExcludeTermsJson);
  const includeChanged = input.nextIncludeTerms !== undefined
    && !sameGroups(currentIncludes, input.nextIncludeTerms);
  if (includeChanged) return true;
  if (input.nextExcludeTerms === undefined) return false;

  const previous = normalizedAlternatives(currentExcludes);
  const next = normalizedAlternatives(input.nextExcludeTerms);
  return [...previous].some((term) => !next.has(term));
}
