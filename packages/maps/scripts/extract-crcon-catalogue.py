"""Regenerate packages/maps/src/crcon-layer-data.ts: CRCON's map/layer catalogue as CRCON v12.3.0
loads it. Reads the sources AS TEXT with Python's ast module; nothing from them is imported or run.

  git -C <crcon clone> show v12.3.0:rcon/maps.py > /tmp/crcon_maps.py
  git -C <hllrcon clone> show 2.0.0.6:hllrcon/data/maps.py > /tmp/hllrcon_maps.py
  git -C <hllrcon clone> show 2.0.0.6:hllrcon/data/layers.py > /tmp/hllrcon_layers.py
  python3 -I packages/maps/scripts/extract-crcon-catalogue.py /tmp/crcon_maps.py /tmp/hllrcon_maps.py \
      /tmp/hllrcon_layers.py packages/maps/src/crcon-layer-data.ts

hllrcon is the version CRCON's uv.lock pins for that release (2.0.0.6 for v12.3.0).
"""
import ast
import json
import sys

FACTION_NAME = {"US": "us", "GER": "ger", "RUS": "rus", "SOV": "rus", "CW": "cw", "GB": "cw",
                "B8A": "b8a", "DAK": "dak", "CAN": "can", "NVA": "nva"}


def kw(call):
    return {k.arg: k.value for k in call.keywords}


def const(node):
    assert isinstance(node, ast.Constant), ast.dump(node)
    return node.value


def attr_tail(node):
    # Team.ALLIES -> "ALLIES"
    assert isinstance(node, ast.Attribute), ast.dump(node)
    return node.attr


def faction(call):
    k = kw(call)
    name = k["name"]
    # FactionName.US.value or a literal
    if isinstance(name, ast.Attribute) and name.attr == "value":
        fname = FACTION_NAME[name.value.attr]
    elif isinstance(name, ast.Name) and name.id == "UNKNOWN_MAP_NAME":
        fname = "unknown"
    else:
        fname = const(name)
    return {"name": fname, "team": attr_tail(k["team"]).lower()}


def crcon_catalogue(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    maps, layers = [], []
    for node in tree.body:
        if not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)):
            continue
        target = node.targets[0].id
        if target not in ("MAPS", "LAYERS"):
            continue
        comp = node.value
        assert isinstance(comp, ast.DictComp)
        for call in comp.generators[0].iter.elts:
            k = kw(call)
            if target == "MAPS":
                def val(n):
                    if isinstance(n, ast.Name) and n.id == "UNKNOWN_MAP_NAME":
                        return "unknown"
                    return const(n)
                maps.append({
                    "id": val(k["id"]), "name": val(k["name"]), "tag": val(k["tag"]),
                    "pretty_name": val(k["pretty_name"]), "shortname": val(k["shortname"]),
                    "allies": faction(k["allies"]), "axis": faction(k["axis"]),
                    "orientation": attr_tail(k["orientation"]).lower(),
                })
            else:
                m = k["map"]
                assert isinstance(m, ast.Subscript)
                key = m.slice
                map_key = "unknown" if isinstance(key, ast.Name) and key.id == "UNKNOWN_MAP_NAME" else const(key)
                lid = k["id"]
                layer_id = "unknown" if isinstance(lid, ast.Name) and lid.id == "UNKNOWN_MAP_NAME" else const(lid)
                layers.append({
                    "id": layer_id, "map": map_key,
                    "game_mode": attr_tail(k["game_mode"]).lower(),
                    "attackers": attr_tail(k["attackers"]).lower() if "attackers" in k and not (isinstance(k["attackers"], ast.Constant) and k["attackers"].value is None) else None,
                    "environment": attr_tail(k["environment"]).lower() if "environment" in k else "day",
                })
    return maps, layers


DIRECTION = {"LEFT_TO_RIGHT": "horizontal", "RIGHT_TO_LEFT": "horizontal",
             "TOP_TO_BOTTOM": "vertical", "BOTTOM_TO_TOP": "vertical"}
HLLV_FACTIONS = {"US": {"name": "us", "team": "allies"}, "NVA": {"name": "nva", "team": "axis"}}


def class_methods(tree, class_name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    ret = item.body[-1]
                    if isinstance(ret, ast.Return) and isinstance(ret.value, ast.Call):
                        yield item.name, ret.value


def hllv_maps(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = {}
    for name, call in class_methods(tree, "HLLVMap"):
        k = kw(call)
        out[name] = {
            "id": const(k["id"]), "name": const(k["name"]), "tag": const(k["tag"]),
            "pretty_name": const(k["pretty_name"]), "shortname": const(k["short_name"]),
            "allies": HLLV_FACTIONS[attr_tail(k["allies"])], "axis": HLLV_FACTIONS[attr_tail(k["axis"])],
            "orientation": DIRECTION[attr_tail(k["allies_direction"])],
        }
    return out


def hllv_layers(path, maps_by_const):
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = []
    for name, call in class_methods(tree, "HLLVLayer"):
        k = kw(call)
        if "id" not in k:
            continue
        tod = attr_tail(k["time_of_day"])
        weather = attr_tail(k["weather"])
        # CRCON's Environment.from_hllrcon: time of day first, then rain/snow, then overcast.
        if tod in ("NIGHT", "DUSK", "DAWN"):
            env = tod.lower()
        elif weather in ("RAIN", "SNOW"):
            env = "rain"
        elif weather == "OVERCAST":
            env = "overcast"
        else:
            env = "day"
        at = k.get("attacking_team")
        attackers = None
        if at is not None and not (isinstance(at, ast.Constant) and at.value is None):
            attackers = {"ALLIES": "allies", "SOUTH": "allies", "AXIS": "axis", "NORTH": "axis"}[attr_tail(at)]
        out.append({
            "id": const(k["id"]),
            "map": maps_by_const[attr_tail(k["map"])]["id"].lower(),
            "game_mode": attr_tail(k["game_mode"]).lower(),
            "attackers": attackers,
            "environment": env,
        })
    return out



import json
import sys

HEADER = '''/**
 * CRCON's map and layer catalogue, as CRCON v12.3.0 loads it. GENERATED — do not edit by hand:
 * regenerate with packages/maps/scripts/extract-crcon-catalogue.py, which reads the sources below
 * as text (Python's ast module) and never runs them.
 *
 *   WW2 (game "hll"):     rcon/maps.py, MAPS and LAYERS, at MarechJ/hll_rcon_tool v12.3.0
 *   Vietnam (game "hllv"): hllrcon 2.0.0.6 (the version CRCON v12.3.0 locks), HLLVMap and
 *                          HLLVLayer in hllrcon/data/, which CRCON's rcon/game/hllv/maps.py turns
 *                          into its catalogue with Map.from_hllrcon / Layer.from_hllrcon
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal
 * and from hllrcon — https://github.com/timraay/hllrcon
 *   Copyright (c) 2025 Tim Raaymakers
 *
 *   Both MIT: Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * ---------------------------------------------------------------------------------------------
 *
 * Maps are CRCON's Map fields in its own order; Vietnam's faction is the faction's short name
 * lowercased and its orientation follows the allied attack direction, as Map.from_hllrcon makes
 * them. Layers are [id, map key, game mode, attackers, environment]; a Vietnam environment is
 * already folded from time of day and weather the way Environment.from_hllrcon folds it.
 */
import type { CrconMapData } from "./crcon-layers.js";

'''


def ts_str(s):
    return json.dumps(s, ensure_ascii=False)


def map_line(m):
    return ("  { id: %s, name: %s, tag: %s, pretty_name: %s, shortname: %s, allies: { name: %s, team: %s }, axis: { name: %s, team: %s }, orientation: %s },"
            % (ts_str(m["id"]), ts_str(m["name"]), ts_str(m["tag"]), ts_str(m["pretty_name"]), ts_str(m["shortname"]),
               ts_str(m["allies"]["name"]), ts_str(m["allies"]["team"]), ts_str(m["axis"]["name"]), ts_str(m["axis"]["team"]),
               ts_str(m["orientation"])))


def layer_line(l):
    return "  [%s, %s, %s, %s, %s]," % (ts_str(l["id"]), ts_str(l["map"]), ts_str(l["game_mode"]),
                                       "null" if l["attackers"] is None else ts_str(l["attackers"]), ts_str(l["environment"]))



def main():
    crcon_maps, crcon_layers = crcon_catalogue(sys.argv[1])
    vmaps = hllv_maps(sys.argv[2])
    vlayers = hllv_layers(sys.argv[3], vmaps)
    d = {"hll": {"maps": crcon_maps, "layers": crcon_layers},
         "hllv": {"maps": list(vmaps.values()), "layers": vlayers}}
    out = [HEADER]
    out.append("/** WW2: rcon/maps.py MAPS, in its order (the order parse_layer searches tags in). */")
    out.append("export const HLL_MAPS: readonly CrconMapData[] = [")
    out += [map_line(m) for m in d["hll"]["maps"]]
    out.append("];\n")
    out.append("/** WW2: rcon/maps.py LAYERS, in its order. */")
    out.append("export const HLL_LAYERS: readonly (readonly [string, string, string, string | null, string])[] = [")
    out += [layer_line(l) for l in d["hll"]["layers"]]
    out.append("];\n")
    out.append("/** Vietnam: hllrcon 2.0.0.6 HLLVMap.all(), as Map.from_hllrcon reads each (CRCON adds its own \"unknown\" first). */")
    out.append("export const HLLV_MAPS: readonly CrconMapData[] = [")
    out += [map_line(m) for m in d["hllv"]["maps"]]
    out.append("];\n")
    out.append("/** Vietnam: hllrcon 2.0.0.6 HLLVLayer.all(), as Layer.from_hllrcon reads each (CRCON adds its own \"unknown\" first). */")
    out.append("export const HLLV_LAYERS: readonly (readonly [string, string, string, string | null, string])[] = [")
    out += [layer_line(l) for l in d["hllv"]["layers"]]
    out.append("];\n")
    open(sys.argv[4], "w", encoding="utf-8").write("\n".join(out))


main()
