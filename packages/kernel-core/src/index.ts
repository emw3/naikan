/**
 * @naikan/kernel-core — placeholder kernel package.
 *
 * Kernel packages (`packages/*`) are plain TypeScript with NO Bun-specific APIs,
 * so the worker process can fall back to a Node runtime without contamination
 * (see ADR-0005). The real kernel modules — scheduler, incident-machine,
 * heartbeat-runner, etc. — land in later issues and follow this convention.
 *
 * This file exists only to establish the convention; keep it runtime-agnostic.
 */

/** Marker confirming the kernel is intended to run on either Bun or Node. */
export const RUNTIME_AGNOSTIC = true;

/** Identity/version stamp for the kernel package. */
export const KERNEL_NAME = "@naikan/kernel-core";
