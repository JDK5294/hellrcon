/**
 * The CRCON mounts' HTTP edges, as CRCON v12.3.0's web stack answers them: how Django (4.2.30, its
 * lock file's) hands a query to CRCON's views, the pages Django answers when a view does not
 * answer itself, and how its Postgres (12) reads a number it is handed as text. Read from those
 * sources, never from memory.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 * Django's stock error page is Django's own: its licence sits beside it, below.
 */

/**
 * A request's arguments as CRCON's views read them (rconweb/api/utils.py `_get_data`): each key
 * once, in the order it first appears, holding its one value, or the list of all of them when the
 * key repeats. A `Map`, because a JavaScript object would move keys like "1" to the front, and
 * get_map_scoreboard echoes these back in its `arguments`.
 */
export type CrconArgs = Map<string, string | string[]>;

/** Django's DATA_UPLOAD_MAX_NUMBER_FIELDS, which CRCON leaves at its default. */
const MAX_FIELDS = 1000;

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/** bytes.decode("utf-8", "replace"); a BOM stays, as it does in Python. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** urllib's _unquote_impl over a run of ASCII: each %XX (either case) a byte, and a "%" that
 *  starts no pair kept as it is. */
function unquoteBytes(run: string): Uint8Array {
  const parts = run.split("%");
  const out: number[] = [...Buffer.from(parts[0]!, "latin1")];
  for (const part of parts.slice(1)) {
    const pair = part.slice(0, 2);
    if (HEX_PAIR.test(pair)) out.push(parseInt(pair, 16), ...Buffer.from(part.slice(2), "latin1"));
    else out.push(0x25, ...Buffer.from(part, "latin1"));
  }
  return new Uint8Array(out);
}

/** urllib's unquote_plus: "+" is a space; then each run of ASCII is unquoted to bytes and read as
 *  UTF-8 with what is not UTF-8 replaced, and anything else passes through as it is. */
function unquotePlus(s: string): string {
  const spaced = s.replace(/\+/g, " ");
  if (!spaced.includes("%")) return spaced;
  let out = "";
  let run = "";
  for (const ch of spaced) {
    if (ch.charCodeAt(0) < 0x80) {
      run += ch;
      continue;
    }
    out += utf8.decode(unquoteBytes(run)) + ch;
    run = "";
  }
  return out + utf8.decode(unquoteBytes(run));
}

/**
 * `request.GET` as Django builds it (QueryDict over parse_qsl, blank values kept) and `_get_data`
 * reads it, from a request's URL. Null where Django refuses the query: more fields than
 * DATA_UPLOAD_MAX_NUMBER_FIELDS, counted as parse_qsl counts them (one more than the "&"s, empty
 * fields included), which Django answers with its 400 page once a view reads the arguments.
 */
export function crconArgs(url: string): CrconArgs | null {
  // gunicorn's split (urlsplit): a fragment off first, then the query after the first "?".
  const head = url.split("#")[0]!;
  const at = head.indexOf("?");
  const qs = at < 0 ? "" : head.slice(at + 1);
  const fields = new Map<string, string[]>();
  if (qs) {
    if (qs.split("&").length > MAX_FIELDS) return null;
    for (const field of qs.split("&")) {
      if (!field) continue;
      const eq = field.indexOf("=");
      const name = unquotePlus(eq < 0 ? field : field.slice(0, eq));
      const value = unquotePlus(eq < 0 ? "" : field.slice(eq + 1));
      const list = fields.get(name);
      if (list) list.push(value);
      else fields.set(name, [value]);
    }
  }
  return new Map([...fields].map(([k, v]) => [k, v.length === 1 ? v[0]! : v]));
}

/*
 * The page below is Django's ERROR_PAGE_TEMPLATE (django/views/defaults.py, Django 4.2.30),
 * https://github.com/django/django, reproduced under its licence:
 *
 * Copyright (c) Django Software Foundation and individual contributors.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *     1. Redistributions of source code must retain the above copyright notice,
 *        this list of conditions and the following disclaimer.
 *
 *     2. Redistributions in binary form must reproduce the above copyright
 *        notice, this list of conditions and the following disclaimer in the
 *        documentation and/or other materials provided with the distribution.
 *
 *     3. Neither the name of Django nor the names of its contributors may be used
 *        to endorse or promote products derived from this software without
 *        specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/** Django's stock error page (django/views/defaults.py ERROR_PAGE_TEMPLATE). CRCON ships no
 *  400.html or 500.html of its own, so this is the page its API answers with. */
const djangoPage = (title: string): string =>
  `\n<!doctype html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <h1>${title}</h1><p></p>\n</body>\n</html>\n`;

/** What Django answers for a refused request (bad_request) and for a view that raised (server_error). */
export const DJANGO_400 = djangoPage("Bad Request (400)");
export const DJANGO_500 = djangoPage("Server Error (500)");
/** The content type of every Django page, and of its empty 405 and preflight answers. */
export const DJANGO_HTML = "text/html; charset=utf-8";

/** int4in's pg_strtoint32 at Postgres 12: C's isspace (musl's six) around a sign and ASCII digits. */
const PG_INT4 = /^[\t\n\v\f\r ]*([+-]?[0-9]+)[\t\n\v\f\r ]*$/;

/**
 * Text compared with an integer column, as CRCON's Postgres (postgres:12-alpine) reads it: the
 * int32, or null where Postgres raises (not a number to it, or out of int32's range).
 */
export function pgInt4(s: string): number | null {
  const m = PG_INT4.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}
