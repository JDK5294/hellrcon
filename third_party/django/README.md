# Django — licence for material derived from it

**Django** — <https://github.com/django/django> — Copyright (c) Django Software Foundation and
individual contributors. Licensed **BSD 3-Clause**; the full text is in `LICENSE` beside this
file, copied verbatim from the project at tag `4.2.30` (the Django CRCON v12.3.0 locks). Its first
condition is that source redistributions keep that copyright notice, the conditions and the
disclaimer, which is what this folder is for.

No Django source is vendored here. What this repository takes from it:

| File in this repository | What comes from Django |
|---|---|
| `apps/api/src/crcon-http.ts` | the stock error page CRCON's mounts answer with (`ERROR_PAGE_TEMPLATE` in `django/views/defaults.py`), reproduced so the pages match byte for byte |

The same file also reproduces how Django reads a query string (`QueryDict` over `parse_qsl`); that
is matching behaviour, written here, not Django's code.

The Django name is used only to say where this came from, never to endorse this project
(condition 3 of the licence).
