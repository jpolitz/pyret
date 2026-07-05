#lang pollen
◊(define (sref s)
  (a-id s (xref "json-structs" s)))


◊docmodule["json"]{
◊ignore[(list "j-obj" "j-arr" "j-num" "j-str" "j-bool" "j-null")]
  ◊para{
  This module re-exports the constructors from ◊sref["JSON"],
  which defines the result of parsing a JSON expression.
  }

  ◊function["read-json" #:args '(("json-str" ""))
    #:contract (a-arrow (a-id "String" (xref "<global>" "String"))
                        (a-id "JSON" (xref "json-structs" "JSON")))]{
    Reads a ◊emph{JSON expression} as a string, and returns it as a Pyret value.

    A JSON expression is a string that satisfies the following grammar:

    ◊verbatim{
JSON = "{" <string> ":" JSON "," ... <string> ":" JSON "}"
      | "[" JSON "," ... JSON "]"
      | <number>
      | <string>
      | <boolean>
      | null
    }

    The first form parses to a ◊sref["j-obj"] containing a
    ◊(a-id StringDict (xref "string-dict" StringDict)) with the strings
    before the colons as keys and the results of converting the JSON
    expressions after the colons as values.
    The second form parses to a ◊sref["j-arr"] containing the nested
    sub-expression results as a list.
    Numbers become ◊sref["j-num"]s, strings become
    ◊sref["j-str"]s, the strings ◊pyret{true} and ◊pyret{false} become
    ◊sref["j-bool"]s, and the string ◊pyret{null} becomes ◊sref["j-null"].

◊examples{
import json as J
import string-dict as SD

p = J.read-json

check:
  p("0") is J.j-num(0)
  p('"a"') is J.j-str("a")
  p("[]") is J.j-arr([list:])
  p("{}") is J.j-obj([SD.string-dict:])
  p("true") is J.j-bool(true)
  p("false") is J.j-bool(false)
  p("null") i J.j-null

  p('{"foo": 1, "baz": true}') is
    J.j-obj([SD.string-dict: "foo", J.j-num(1), "baz", J.j-bool(true)])
  p('[1,2,3]') is J.j-arr([list: J.j-num(1), J.j-num(2), J.j-num(3)])
  p('[[[]]]') is J.j-arr([list: J.j-arr([list: J.j-arr([list:])])])
  p('[5, null, {"hello": "world"}]') is
    J.j-arr([list: J.j-num(5), J.j-null,
      J.j-obj([SD.string-dict: "hello", J.j-str("world")])])

end
}
