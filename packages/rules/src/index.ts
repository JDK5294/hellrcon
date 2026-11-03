/**
 * @app/rules — the roster-state triggers behind the Rules engine (Auto settings → Rules). Each
 * trigger declares its param schema and a pure `detect`; the worker runs detection against the
 * live roster and the enforcer supplies immunity, escalation, messaging, alerts and audit.
 */
export * from "./contract.js";
export * from "./state-triggers.js";
export * from "./player-roster.js";
