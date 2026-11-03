/**
 * HLL: Vietnam — every weapon name the game writes into a KILL log line, including the quirks the
 * game itself emits: the "Dhsk" spelling on the boat gun, "M48Patton" with no space, and bracketed
 * mount forms alongside bare ones. Internal spelling is verbatim — do NOT tidy it; a restriction
 * matches only if it is identical (case aside) to what the log says.
 *
 * The ONE normalisation applied is a trim: the reference export carries "M79 " and "M72 " with a
 * trailing space, but our log normalizer trims the weapon field on every kill line, so a name
 * with outer whitespace could never match anything — it would be a picker row that can't fire.
 *
 * Source: `hllrcon` 2.0.0.3, hllrcon/data/weapons.py (the same reference export data.ts derives
 * the role/weapon-class tables from) — every HLLVWeapon id whose type is lethal, minus the
 * "Unknown" placeholders and minus the commander abilities, which live in their own list below.
 * When the game patches, re-derive from the new release rather than editing names in place.
 *
 * A leaf module (no relative imports) so tests can load it under node --experimental-strip-types.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from hllrcon — https://github.com/timraay/hllrcon
 *   Copyright (c) 2025 Tim Raaymakers. MIT License; full text in third_party/hllrcon/LICENSE.
 */

export const HLLV_WEAPON_NAMES: string[] = [
  "AN-M8 Flare",
  "Chi Com Signal Pistol",
  "DH10 AP Mine",
  "IZH 58",
  "K50M",
  "K50M Drum",
  "Knife",
  "LPO-50",
  "M16A1",
  "M16A1 Bayonet",
  "M16A1-M203",
  "M183 Demolition Charge",
  "M18 Claymore",
  "M1911A1",
  "M21 AT Mine",
  "M2A1-7",
  "M3 Knife",
  "M40",
  "M60",
  "M61",
  "M72",
  "M79",
  "Model 77E",
  "RPD",
  "RPG-02",
  "Satchel Charge",
  "TM-46 AT Mine",
  "TNT",
  "Type 53 Bayonet",
  "Type 53 N4 Rifle Launcher",
  "Type 53 PU",
  "Type 54",
  "Type 56 Bayonet",
  "Type 67",
  "100MM D-10T CANNON",
  "100MM D-10T CANNON [T54]",
  "90MM M41 CANNON",
  "90MM M41 CANNON [M48Patton]",
  "DShKM Anti-Aircraft Gun",
  "DShKM Anti-Aircraft Gun [DShKM Anti-Aircraft Gun]",
  "Dhsk",
  "Dhsk [NVA Boat]",
  "Flare Gun",
  "Flare Gun [US Transport Helicopter]",
  "Gaz 63 (Supply)",
  "Gaz 63 (Transport)",
  "M2 Browning",
  "M2 Browning [US Boat]",
  "M35 (Supply)",
  "M35 (Transport)",
  "M48Patton",
  "M60D",
  "M60D [US Transport Helicopter]",
  "M73",
  "M73 [M48Patton]",
  "MORTAR",
  "MORTAR [MORTAR]",
  "NVA Boat",
  "RPD [NVA Boat]",
  "SGMT 7.62MM",
  "SGMT 7.62MM [T54]",
  "T54",
  "US Boat",
  "US Supply Helicopter",
  "US Transport Helicopter",
];

/**
 * The commander abilities that kill, exactly as they appear as a kill line's weapon — typed
 * COMMANDER_ABILITY by the reference export. Vietnam swaps HLL's bombing run for napalm and adds
 * an artillery strike (mixed-case in the log, kept verbatim; matching folds case anyway).
 */
export const HLLV_COMMANDER_ABILITIES: string[] = ["NAPALM STRIKE", "STRAFING RUN", "Artillery Strike", "PRECISION STRIKE"];
