/**
 * Parse dependency references from an issue body.
 *
 * Recognizes patterns written by oh-plan and common variations:
 * - **Depends on:** #43 (oh-plan standard format, with bold)
 * - *Depends on:* #43 (italic variant)
 * - Depends on: #43, #44 (comma-separated, with colon)
 * - Depends on #43 (without colon)
 * - Depends on: #43 and #44 (with "and" separator)
 *
 * Returns deduplicated array of issue numbers.
 */
export function parseDependencies(body: string | null | undefined): number[] {
  if (!body) return [];

  const deps = new Set<number>();

  // Match "Depends on" with optional bold/italic markers and optional colon,
  // followed by one or more #N references separated by commas, "and", or whitespace
  const pattern = /\*{0,2}Depends on:?\*{0,2}:?\s*(.+)/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const rest = match[1];
    // Extract all #N references from the remainder of the line
    const refs = rest.match(/#(\d+)/g);
    if (refs) {
      for (const ref of refs) {
        const num = parseInt(ref.slice(1), 10);
        if (!isNaN(num) && num > 0) {
          deps.add(num);
        }
      }
    }
  }

  return [...deps];
}

/**
 * Compute which issues are blocked.
 * An issue is blocked if any of its dependsOn issues are not yet resolved
 * (i.e., have no merged PR).
 *
 * @param dependsOn - issue numbers this issue depends on
 * @param mergedIssues - set of issue numbers that have a merged PR
 * @returns issue numbers from dependsOn that are NOT yet merged
 */
export function computeBlockedBy(dependsOn: number[], mergedIssues: Set<number>): number[] {
  return dependsOn.filter((num) => !mergedIssues.has(num));
}
