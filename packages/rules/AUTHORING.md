# Adding a roster-state trigger

`@app/rules` is the detector library behind the Rules engine (Auto settings → Rules). A
"state trigger" is one automated-moderation scenario read off the live roster — solo tank,
no squad leader, level too low — offered in the rule editor's trigger picker beside the log
events. The scenario's knobs live on each RULE as `params`; everything repetitive (immunity,
the warn → punish → kick ladder, dry-run, per-rule Discord alerts, audit) is the enforcer's,
same as for any other rule.

## The moving parts

- **This package** declares the trigger: its kind (`app.state.<name>`), label, param field
  schema, and a PURE `detect({ players, params, descriptor }) → Violation[]`.
- **The worker** runs `detect` each tick for every enabled rule of that kind (with that
  rule's params) and emits one synthetic bus event per offending player, carrying the rule's
  id and the violation sentence.
- **The enforcer** (apps/api) hears the event and fires exactly the rule whose id it carries.
- **The panel** (Enforcer.tsx) mirrors the param fields in `DEFAULT_PARAMS` + `TriggerParams`
  so the editor renders them; the API re-validates every save through `parseTriggerParams`.

## To add one

1. Append a `StateTriggerDef` to `STATE_TRIGGERS` in `src/state-triggers.ts`. Declare
   `games` when the scenario only means something in some games — role ids COLLIDE across
   games (Vietnam's Pilot 16 is WW2's artillery Gunner 16), and both the worker and the
   rule routes refuse to run/pin a trigger where it does not apply.
2. Give every param a field entry (type, default, bounds, help). Include `MIN_PLAYERS_FIELD`
   for roster triggers. Add a never-fires refusal to `parseTriggerParams` if an all-blank
   configuration would match nothing — a rule somebody believes is protecting the server
   while it matches nobody is the worst kind of saved.
3. Mirror the fields in the panel's `DEFAULT_PARAMS` and `TriggerParams` (Enforcer.tsx), and
   add the kind's label to its `SYNTHETIC_LABELS`.
4. Test `detect` and the param validation in `test/rules.test.ts` — pure functions, no game
   server needed. The enforcer's matching (`ruleId` gating, `{violation}` fill) is covered in
   `apps/api/test/enforcer.test.ts`.

Kill-shaped scenarios (an event with knobs, like `app.weapon.restricted`) skip the worker
entirely: the enforcer judges the kill event inline. Follow `restrictedWeaponReason`.
