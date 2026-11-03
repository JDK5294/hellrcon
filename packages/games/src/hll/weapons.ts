/**
 * HLL weapon buckets for kill/death-type breakdowns on player profiles. A leaf module (no relative
 * imports) so tests can load it under node --experimental-strip-types, same as commands/log/match.
 */
import type { GameWeaponClass } from "../types.js";

  // ORDER IS THE RULE: first matching pattern wins, so the specific buckets come before the
  // general ones they'd otherwise be swallowed by. "KARABINER 98K x8" is a sniper rifle and
  // "COAXIAL MG34" is a tank gun — both would read as bolt-action / machine gun if the broad
  // buckets ran first. Patterns are case-insensitive substrings of the weapon the log reported.
  
export const HLL_WEAPON_CLASSES: GameWeaponClass[] = [
    { id: "melee", label: "Melee", melee: true, patterns: ["KNIFE", "SPADE", "SHOVEL", "FELDSPATEN", "MELEE", "FAIRBAIRN"] },
    { id: "artillery", label: "Artillery", patterns: ["HOWITZER", "POUNDER", "ARTILLERY"] },
    // Deliberately NOT a bare "PANZER": that also matches PANZERSCHRECK and PANZERFAUST, which
    // are the AT launchers an infantryman carries, not vehicles. The tanks are named in full.
    { id: "armor", label: "Armor", patterns: [
      "COAXIAL", "HULL MG", "SHERMAN", "TIGER", "PUMA", "GREYHOUND", "STUART", "CHAFFEE",
      "T34", "IS-1", "KV-1", "KV-2", "T70", "BA-10", "CRUSADER", "TETRARCH", "FIREFLY", "CROMWELL", "CHURCHILL", "SD.KFZ",
      "M8 ", "M3 HALFTRACK", "M4A3", "DAIMLER", "BISHOP", "PANZER I", "PANZERKAMPFWAGEN", "PANTHER", "FLAKPANZER", "FLAMMPANZER",
      "JAGDPANZER", "STUG", "LUCHS",
    ] },
    { id: "explosive", label: "Explosives & AT", patterns: [
      "PANZERSCHRECK", "PANZERFAUST", "BAZOOKA", "PIAT", "SATCHEL", "MINE", "AT GUN", "FLAMETHROWER",
      "FLAMMENWERFER", "BOMBING RUN", "STRAFING RUN", "PAK ", "FLAK ", "ZIS-2", "M1 57MM",
    ] },
    { id: "grenade", label: "Grenades", patterns: ["GRENADE", "MOLOTOV", "STIELHANDGRANATE", "MK2", "MK 2", "MILLS BOMB", "NO.77"] },
    { id: "sniper", label: "Sniper", patterns: ["X4", "X8", "SCOPED", "SPRINGFIELD"] },
    { id: "mg", label: "Machine gun", patterns: ["MG42", "MG34", "BROWNING M1919", "DP-27", "VICKERS", "M2 BROWNING", "BREN", "FG42", "BAR", "M1918", "LEWIS GUN"] },
    // AFTER the gun buckets on purpose: a mounted gun's name carries its vehicle in brackets
    // ("M2 Browning [M3 Half-track]") and is the GUN — only the bare vehicle, killing by roadkill,
    // should land here. Before this bucket existed, "M3 Half-track" read as an SMG via "M3 ".
    { id: "vehicle", label: "Vehicle", patterns: ["(TRANSPORT)", "(SUPPLY)", "JEEP", "KUBELWAGEN", "GAZ-67", "HALF-TRACK"] },
    { id: "shotgun", label: "Shotgun", patterns: ["TRENCH GUN", "SHOTGUN"] },
    { id: "smg", label: "SMG", patterns: ["MP40", "MP34", "THOMPSON", "GREASE GUN", "PPSH", "STEN", "STG44", "SUOMI", "LANCHESTER", "M3 "] },
    { id: "pistol", label: "Pistol", patterns: ["M1911", "LUGER", "WALTHER", "WEBLEY", "TOKAREV", "P38", "P08", "REVOLVER", "M1895", "FN-INGLIS", "FLARE"] },
    { id: "rifle", label: "Rifle", patterns: [
      "GARAND", "KARABINER", "GEWEHR", "CARBINE", "MOSIN", "SVT40", "LEE-ENFIELD", "ENFIELD", "SMLE", "PTRS", "RIFLE",
    ] },
  ];
