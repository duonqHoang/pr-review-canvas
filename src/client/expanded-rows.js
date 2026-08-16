/**
 * Reconcile context fetched from opposite ends of the same hunk gap.
 *
 * Each expand control owns an independent cursor, so two valid responses can overlap. The line key
 * is the renderer's mode-independent identity; retaining only its first occurrence makes the two
 * expansions meet without showing the shared lines twice.
 */

/**
 * @param {Iterable<string>} existing
 * @param {string[]} incoming
 * @returns {number[]}
 */
export function unseenLineIndexes(existing, incoming) {
  const seen = new Set(existing);
  /** @type {number[]} */
  const indexes = [];
  incoming.forEach((key, index) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    indexes.push(index);
  });
  return indexes;
}
