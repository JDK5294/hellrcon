/**
 * @app/access — authentication (passwords, API tokens, sessions) and per-server RBAC.
 * Pure, dependency-free (Node crypto only), so it's fully unit-testable and safe to reuse
 * anywhere in the system.
 */
export { hashPassword, verifyPassword } from "./password.js";
export { generateToken, hashToken, looksLikeToken } from "./tokens.js";
export type { GeneratedToken } from "./tokens.js";
export { resolveLevel, can, canAnywhere, ownerGrants, mappedRoleAssignments } from "./rbac.js";
export { CAPABILITY_CATALOG, ROLE_PRESETS, LIMIT_CATALOG, CAPABILITY_SPLITS, capabilityLevels, minLevelFor } from "./capabilities.js";
export type { CapabilityDef, RolePreset, LimitDef } from "./capabilities.js";
export { approvalRefusal, holdsOutright, requestViewGrants, REQUEST_VIEW_SOURCE, previewRoleGrants } from "./rbac.js";
export type { Grant, ResolveContext } from "./rbac.js";
export { signSession, verifySession, sessionClaims } from "./session.js";
export { sealSecret, openSecret, isSealed } from "./seal.js";
export type { SessionClaims } from "./session.js";
