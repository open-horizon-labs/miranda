import { realpath } from "fs/promises";
import { sep, resolve } from "path";

/**
 * Check if a path is safely contained within a parent directory.
 * Uses realpath canonicalization to resolve symlinks and prevent escapes.
 * For non-existent paths, falls back to path.resolve() normalization.
 *
 * @param childPath - Path to verify (may not exist yet)
 * @param parentPath - Parent directory that must contain childPath
 * @returns true if childPath is within parentPath after canonicalization
 */
export async function isPathWithin(childPath: string, parentPath: string): Promise<boolean> {
  try {
    // Try realpath first for existing paths (resolves symlinks)
    const resolvedChild = await realpath(childPath);
    const resolvedParent = await realpath(parentPath);
    // Ensure child starts with parent + separator to prevent prefix attacks
    // e.g., /projects-evil matching /projects
    return resolvedChild === resolvedParent ||
           resolvedChild.startsWith(resolvedParent + sep);
  } catch {
    // Path doesn't exist - fall back to resolve() for normalization
    // This allows validation of non-existent paths while still being secure
    try {
      const resolvedParent = await realpath(parentPath);
      const normalizedChild = resolve(childPath);
      return normalizedChild === resolvedParent ||
             normalizedChild.startsWith(resolvedParent + sep);
    } catch {
      // Parent doesn't exist or other error
      return false;
    }
  }
}
