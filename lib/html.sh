#!/usr/bin/env bash
# lib/html.sh — small HTML rendering helpers for static report generators.
#
# All helpers write to stdout. They are deliberately kept simple — no DOM,
# no templating engine, no JS. Keep the contract minimal so callers can
# compose freely.
#
# Public:
#   html_escape <stdin>            — escape & < > " ' for HTML text/attribute
#                                    contexts. Stream-safe (line-by-line via sed).
#   html_escape_arg <string>       — same, but for a single argument.
#   html_table_open <th> [<th>...] — emit `<table><thead><tr>…</tr></thead><tbody>`.
#                                    Header cells are escaped.
#   html_table_close               — emit `</tbody></table>`.
#   html_table_row <td> [<td>...]  — emit `<tr><td>…</td></tr>` with cells escaped.
#   html_details_open <summary>    — emit `<details><summary>…</summary><pre>`.
#                                    Summary is escaped.
#   html_details_close             — emit `</pre></details>`.

html_escape() {
  # & must be replaced first so that subsequent replacements don't double-escape.
  sed -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g'  \
      -e 's/>/\&gt;/g'  \
      -e 's/"/\&quot;/g' \
      -e "s/'/\\&#39;/g"
}

html_escape_arg() {
  printf '%s' "${1-}" | html_escape
}

html_table_open() {
  printf '<table><thead><tr>'
  local h
  for h in "$@"; do
    printf '<th>'
    printf '%s' "${h}" | html_escape
    printf '</th>'
  done
  printf '</tr></thead><tbody>\n'
}

html_table_close() {
  printf '</tbody></table>\n'
}

html_table_row() {
  printf '<tr>'
  local c
  for c in "$@"; do
    printf '<td>'
    printf '%s' "${c}" | html_escape
    printf '</td>'
  done
  printf '</tr>\n'
}

html_details_open() {
  local summary="${1-}"
  printf '<details><summary>'
  printf '%s' "${summary}" | html_escape
  printf '</summary><pre>'
}

html_details_close() {
  printf '</pre></details>\n'
}
