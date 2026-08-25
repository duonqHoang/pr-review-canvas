import { createHash } from "node:crypto";

/**
 * Stable units for an opt-in agent review.
 *
 * A head SHA is deliberately not the marker: an unrelated push changes the head while leaving most
 * files byte-for-byte identical, and charging the user to review those files again would defeat the
 * incremental scan. The parsed patch is the evidence the agent reviews, so its content hash is the
 * durable identity. Files whose patch is unavailable still include their metadata and blob SHA; a
 * changed blob therefore becomes reviewable again even when GitHub withholds its patch.
 */

/** @param {import("./diff/model.js").ParsedFile} file */
export function findingScopeFingerprint(file) {
  const evidence =
    file.rawPatch ??
    JSON.stringify({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      blobSha: file.blobSha,
      patchAvailability: file.patchAvailability,
      additions: file.additions,
      deletions: file.deletions,
    });
  return createHash("sha256").update(evidence, "utf8").digest("hex");
}

/**
 * @param {import("./snapshot.js").Snapshot} snapshot
 * @param {Record<string, { at: string, headSha: string }>} reviewed
 */
export function unreviewedFindingScopes(snapshot, reviewed) {
  return snapshot.files
    .map((file) => ({ file, fingerprint: findingScopeFingerprint(file) }))
    .filter(({ fingerprint }) => !reviewed[fingerprint])
    .map(({ file, fingerprint }) => ({
      path: file.path,
      fingerprint,
      patchAvailability: file.patchAvailability,
      additions: file.additions,
      deletions: file.deletions,
      rawPatch: file.rawPatch,
    }));
}
