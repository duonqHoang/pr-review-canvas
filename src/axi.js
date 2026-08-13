/**
 * The single seam onto `axi-sdk-js`.
 *
 * We use exactly four symbols from it. Funnelling them through one file means a future
 * replacement (or a breaking 0.x bump) touches this file and nothing else. The version is
 * pinned exactly in package.json for the same reason.
 */
export { AxiError, installSessionStartHooks, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";
