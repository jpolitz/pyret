#lang pyret

provide *
import ast as A
import file("ast-anf.arr") as N
import file("js-ast.arr") as J
import file("gensym.arr") as G
import file("compile-structs.arr") as CS
import file("concat-lists.arr") as CL
import file("flatness.arr") as FL
import file("js-dag-utils.arr") as DAG
import file("ast-util.arr") as AU
import file("type-structs.arr") as T
import string-dict as D
import srcloc as SL
import sets as S
import sha as sha

string-dict = D.string-dict
mutable-string-dict = D.mutable-string-dict

type Loc = SL.Srcloc
type CList = CL.ConcatList
clist = CL.clist

fun get-exp(o): o.exp end
fun get-id(o): o.id end
fun get-name(o): o.name end
fun get-l(o): o.l end
fun get-bind(o): o.bind end
fun o-get-field(o): o.field end

cl-empty = CL.concat-empty
cl-sing = CL.concat-singleton
cl-append = CL.concat-append
cl-cons = CL.concat-cons
cl-snoc = CL.concat-snoc

fun cl-map-sd(f, sd):
  for D.fold-keys(acc from cl-empty, key from sd):
    cl-cons(f(key), acc)
  end
end

fun make-fun-name(compiler, loc) -> String:
  "_" + sha.sha256(compiler.uri) + "__" + num-to-string(compiler.get-loc-id(loc))
end

fun type-name(str :: String) -> String:
  string-append("$type$", str)
end

j-fun = J.j-fun
j-fun-async = J.j-fun-async
j-await = J.j-await
j-var = J.j-var
j-id = J.j-id
j-method = J.j-method
j-block = J.j-block
j-block1 = J.j-block1
j-true = J.j-true
j-false = J.j-false
j-num = J.j-num
j-str = J.j-str
j-return = J.j-return
j-assign = J.j-assign
j-if = J.j-if
j-if1 = J.j-if1
j-new = J.j-new
j-app = J.j-app
j-list = J.j-list
j-obj = J.j-obj
j-dot = J.j-dot
j-bracket = J.j-bracket
j-field = J.j-field
j-dot-assign = J.j-dot-assign
j-bracket-assign = J.j-bracket-assign
j-try-catch = J.j-try-catch
j-throw = J.j-throw
j-expr = J.j-expr
j-binop = J.j-binop
j-and = J.j-and
j-or = J.j-or
j-lt = J.j-lt
j-eq = J.j-eq
j-neq = J.j-neq
j-geq = J.j-geq
j-unop = J.j-unop
j-decr = J.j-decr
j-incr = J.j-incr
j-not = J.j-not
j-typeof = J.j-typeof
j-instanceof = J.j-instanceof
j-ternary = J.j-ternary
j-null = J.j-null
j-parens = J.j-parens
j-switch = J.j-switch
j-case = J.j-case
j-default = J.j-default
j-label = J.j-label
j-break = J.j-break
j-continue = J.j-continue
j-while = J.j-while
j-for = J.j-for
j-raw-code = J.j-raw-code
j-undefined = J.j-undefined
is-j-assign = J.is-j-assign
make-label-sequence = J.make-label-sequence

fun console-log(lst :: CL.ConcatList) -> J.JExpr:
  j-app(j-id(A.s-name(A.dummy-loc, "console.log")), lst)
end
fun console-log-stmt(lst :: CL.ConcatList) -> J.JStmt:
  j-expr(console-log(lst))
end

is-t-data = T.is-t-data

data BindType:
  | b-let(value :: N.ABind)
  | b-array(value :: N.ABind, idx :: Number)
end

# this structure stores bindings of case dispatch objects
# so that the objects can be allocated only once in the top level, avoiding
# multiple allocations which could affect performance, particularly in recursive
# functions.
data Dispatches:
  | dispatches-box(ref dispatches :: CList<J.JStmt>)
end

js-names = A.MakeName(0)
js-ids = D.make-mutable-string-dict()
effective-ids = D.make-mutable-string-dict()
fun fresh-id(id :: A.Name) -> A.Name:
  base-name = if A.is-s-type-global(id): id.tosourcestring() else: id.toname() end
  no-hyphens = string-replace(base-name, "-", "$")
  n = js-names.make-atom(no-hyphens)
  if effective-ids.has-key-now(n.tosourcestring()) block: #awkward name collision!
    fresh-id(id)
  else:
    effective-ids.set-now(n.tosourcestring(), true)
    n
  end
end
fun js-id-of(id :: A.Name) -> A.Name:
  s = id.key()
  if js-ids.has-key-now(s) block:
    js-ids.get-value-now(s)
  else:
    safe-id = fresh-id(id)
    js-ids.set-now(s, safe-id)
    safe-id
  end
end

fun const-id(name :: String):
  A.s-name(A.dummy-loc, name)
end

fun compiler-name(id):
  const-id(string-append("$",id))
end

fun formal-shadow-name(id :: A.Name) -> A.Name:
  js-id = js-id-of(id)
  A.s-name(A.dummy-loc, string-append("$", js-id.tosourcestring()))
end

get-field-loc = j-id(const-id("G"))
throw-uninitialized = j-id(const-id("U"))
source-name = j-id(const-id("M"))
undefined = j-id(const-id("D"))
RUNTIME = j-id(const-id("R"))
NAMESPACE = j-id(const-id("NAMESPACE"))
THIS = j-id(const-id("this"))
ARGUMENTS = j-id(const-id("arguments"))

rt-name-map = [D.string-dict:
  "addModuleToNamespace", "aMTN",
  "checkArityC", "cAC",
  "checkRefAnns", "cRA",
  "derefField", "dF",
  "getColonFieldLoc", "gCFL",
  "getDotAnn", "gDA",
  "getField", "gF",
  "getFieldRef", "gFR",
  "getBracket", "gB",
  "hasBrand", "hB",
  "isActivationRecord", "isAR",
  "isCont", "isC",
  "isFunction", "isF",
  "isMethod", "isM",
  "isPyretException", "isPE",
  "isPyretTrue", "isPT",
  "makeActivationRecord", "mAR",
  "makeBoolean", "mB",
  "makeBranderAnn", "mBA",
  "makeCont", "mC",
  "makeDataValue", "mDV",
  "makeFunction", "mF",
  "makeGraphableRef", "mGR",
  "makeMatch", "mM",
  "makeMethod", "mMet",
  "makeMethodN", "mMN",
  "makeObject", "mO",
  "makePredAnn", "mPA",
  "makeRecordAnn", "mRA",
  "makeTupleAnn", "mTA",
  "makeVariantConstructor", "mVC",
  "namedBrander", "nB",
  "profileEnter", "pEn",
  "profileExit", "pEx",
  "traceEnter", "tEn",
  "traceErrExit", "tErEx",
  "traceExit", "tEx",
  '_checkAnn', '_cA'
]

j-bool = lam(b):
  if b: j-true else: j-false end
end

fun obj-of-loc(l):
  cases(Loc) l:
    | builtin(name) => j-list(false, [clist: j-str(name)])
    | srcloc(source, start-line, start-col, start-char, end-line, end-col, end-char) =>
      j-list(false, [clist:
          j-str(source),
          j-num(start-line),
          j-num(start-col),
          j-num(start-char),
          j-num(end-line),
          j-num(end-col),
          j-num(end-char)
        ])
  end
end

fun wrap-with-srcnode(l, expr :: J.JExpr):
  cases(Loc) l:
    | builtin(name) => expr
    | srcloc(source, _, _, _, _, _, _) =>
      J.j-sourcenode(l, source, expr)
  end
end

fun get-dict-field(obj, field):
  j-bracket(j-dot(obj, "dict"), field)
end

# Use when we're sure the field will exist
fun get-field-unsafe(obj :: J.JExpr, field :: J.JExpr, loc-expr :: J.JExpr):
  j-app(get-field-loc, [clist: obj, field, loc-expr])
end

fun get-bracket-unsafe(obj :: J.JExpr, field :: J.JExpr, loc-expr :: J.JExpr):
  rt-method("getBracket", [clist: obj, field, loc-expr])
end

# When the field may not exist, add source mapping so if we can't find it
# we get a useful stacktrace
fun get-field-safe(l, obj :: J.JExpr, field :: J.JExpr, loc-expr :: J.JExpr):
  wrap-with-srcnode(l, get-field-unsafe(obj, field, loc-expr))
end

fun get-bracket-safe(l, obj :: J.JExpr, field :: J.JExpr, loc-expr :: J.JExpr):
  wrap-with-srcnode(l, get-bracket-unsafe(obj, field, loc-expr))
end

fun get-field-ref(obj :: J.JExpr, field :: J.JExpr, loc :: J.JExpr):
  rt-method("getFieldRef", [clist: obj, field, loc])
end

fun raise-id-exn(loc, name):
  j-app(throw-uninitialized, [clist: loc, j-str(name)])
end

fun add-stack-frame(exn-id, loc):
  j-method(j-dot(j-id(exn-id), "pyretStack"), "push", [clist: loc])
end

fun rt-field(name): j-dot(RUNTIME, name) end

fun rt-method(name, args):
  rt-name = cases(Option) rt-name-map.get(name):
    | none => name
    | some(short-name) => short-name
  end

  j-method(RUNTIME, rt-name, args)
end

fun log-and(log, ret):
  j-bracket(j-list(true, [clist: console-log(log), ret]), j-num(1))
end

fun get-field(obj, field):
  rt-method("getField", [clist: obj, j-str(field)])
end

fun get-module-field(uri, which, name):
  rt-method("getModuleField", [clist: j-str(uri), j-str(which), j-str(name)])
end

fun app(l, f, args):
  cases(SL.Srcloc) l:
    | builtin(n) => j-method(f, "app", args)
    | else =>
      J.j-sourcenode(l, l.source, j-method(f, "app", args))
  end
end

fun check-fun(sourcemap-loc, variable-loc, f) block:
  call = cases(SL.Srcloc) sourcemap-loc block:
    | builtin(_) =>
      j-method(rt-field("ffi"), "throwNonFunApp", [clist: variable-loc, f])
    | srcloc(_, _, _, _, _, _, _) =>
      J.j-sourcenode(sourcemap-loc, sourcemap-loc.source,
        j-method(rt-field("ffi"), "throwNonFunApp", [clist: variable-loc, f]))
  end
  j-if1(j-binop(j-unop(j-parens(j-dot(f, "app")), j-typeof), j-neq, j-str("function")),
    j-block1(j-expr(call)))
end

c-exp = DAG.c-exp
c-field = DAG.c-field
c-block = DAG.c-block
is-c-exp = DAG.is-c-exp
is-c-field = DAG.is-c-field
is-c-block = DAG.is-c-block

fun ann-loc(ann):
  if A.is-a-blank(ann): A.dummy-loc
  else: ann.l
  end
end

fun is-flat-enough(flatness):
  cases(Option) flatness:
    | none => false
    | some(v) => v <= 5
  end
end

fun is-function-flat(flatness-env :: FL.FEnv, fun-name :: String) -> Boolean:
  flatness-opt = flatness-env.get-now(fun-name).or-else(none)
  is-flat-enough(flatness-opt)
end



fun compile-ann(ann :: A.Ann, opt-name :: Option<String>, visitor) -> DAG.CaseResults%(is-c-exp):
  cases(A.Ann) ann:
    | a-name(_, n) => c-exp(j-id(js-id-of(n)), cl-empty)
    | a-type-var(_, _) => c-exp(rt-field("Any"), cl-empty)
    | a-arrow(_, _, _, _) => c-exp(rt-field("Function"), cl-empty)
    | a-arrow-argnames(_, _, _, _) => c-exp(rt-field("Function"), cl-empty)
    | a-method(_, _, _) => c-exp(rt-field("Method"), cl-empty)
    | a-app(l, base, _) => compile-ann(base, opt-name, visitor)
    | a-record(l, fields) =>
      comp-fields =
        for fold(acc from {names: cl-empty, locs: cl-empty, fields: cl-empty, others: cl-empty},
            field from fields):
          compiled = compile-ann(field.ann, none, visitor)
          {
            names: cl-snoc(acc.names, j-str(field.name)),
            locs: cl-snoc(acc.locs, visitor.get-loc(field.l)),
            fields: cl-snoc(acc.fields, j-field(field.name, compiled.exp)),
            others: cl-append(acc.others, compiled.other-stmts)
          }
        end
      c-exp(
        rt-method("makeRecordAnn", [clist:
            j-list(false, comp-fields.names),
            j-list(false, comp-fields.locs),
            j-obj(comp-fields.fields),
            if is-some(opt-name): j-str(opt-name.value) else: j-undefined end
          ]),
        comp-fields.others
        )
    | a-tuple(l, tuple-fields) =>
      comp-fields = for fold(acc from {locs: cl-empty, fields: cl-empty, others: cl-empty},
          field from tuple-fields):
        compiled = compile-ann(field, opt-name, visitor)
        {
          locs: cl-snoc(acc.locs, visitor.get-loc(ann-loc(field))),
          fields: cl-snoc(acc.fields, compiled.exp),
          others: cl-append(acc.others, compiled.other-stmts)
        }
      end
      c-exp(
        rt-method("makeTupleAnn", [clist:
            j-list(false, comp-fields.locs),
            j-list(false, comp-fields.fields),
            if is-some(opt-name): j-str(opt-name.value) else: j-undefined end
          ]),
        comp-fields.others
        )
    | a-pred(l, base, exp) =>
      name = cases(A.Expr) exp:
        | s-id(_, id) => id.toname()
        | s-id-letrec(_, id, _) => id.toname()
      end
      expr-to-compile = cases(A.Expr) exp:
        | s-id(l2, id) => N.a-id(l2, id)
        | s-id-letrec(l2, id, ok) => N.a-id-letrec(l2, id, ok)
      end
      compiled-base = compile-ann(base, opt-name, visitor)
      compiled-exp = expr-to-compile.visit(visitor)
      is-flat = is-flat-enough(FL.ann-flatness(base, visitor.flatness-env, visitor.type-flatness-env, visitor.module-bindings, visitor.env))
        and is-function-flat(visitor.flatness-env, exp.id.key())
      pred-maker = if is-flat: "makeFlatPredAnn" else: "makePredAnn" end
      c-exp(
        rt-method(pred-maker, [clist: compiled-base.exp, compiled-exp.exp, j-str(name)]),
        cl-append(compiled-base.other-stmts, compiled-exp.other-stmts)
        )
    | a-dot(l, m, field) =>
      c-exp(
        rt-method("getDotAnn", [clist:
            visitor.get-loc(l),
            j-str(m.toname()),
            j-dot(j-dot(j-id(js-id-of(m)), "dict"), "types"),
            j-str(field)]),
        cl-empty)
    | a-blank => c-exp(rt-field("Any"), cl-empty)
    | a-any(l) => c-exp(rt-field("Any"), cl-empty)
  end
end

fun arity-check(loc-expr, arity :: Number, is-method :: Boolean):
  #|[list:
    j-if1(j-binop(j-dot(ARGUMENTS, "length"), j-neq, j-num(arity)),
      j-block([list:
          j-expr(rt-method("checkArityC", [list: loc-expr, j-num(arity), j-method(rt-field("cloneArgs"), "apply", [list: j-null, ARGUMENTS]), j-bool(is-method)]))
      ]))]|#
  len = j-id(compiler-name("l"))
  iter = j-id(compiler-name("i"))
  t = j-id(compiler-name("t"))
  [clist:
    j-var(len.id, j-dot(ARGUMENTS, "length")),
    j-if1(j-binop(len, j-neq, j-num(arity)),
      j-block([clist:
          j-var(t.id, j-new(j-id(const-id("Array")), [clist: len])),
          j-for(true, j-assign(iter.id, j-num(0)), j-binop(iter, j-lt, len), j-unop(iter, j-incr),
            j-block1(j-expr(j-bracket-assign(t, iter, j-bracket(ARGUMENTS, iter))))),
          j-expr(rt-method("checkArityC", [clist: loc-expr, j-num(arity), t, j-bool(is-method)]))]))]
end

no-vars = D.make-mutable-string-dict

fun local-bound-vars(kase :: J.JCase, vars) block:
  fun e(expr):
    cases(J.JExpr) expr block:
      | j-sourcenode(_, _, exp) => e(exp)
      | j-parens(exp) => e(exp)
      | j-raw-code(_) => nothing
      | j-unop(exp, _) => e(exp)
      | j-binop(left, _, right) =>
        e(left)
        e(right)
      | j-fun(_, _, _, _) =>
        # the body of a function contributes no *locally* bound vars
        nothing
      | j-new(func, args) =>
        e(func)
        args.each(e)
      | j-app(func, args) =>
        e(func)
        args.each(e)
      | j-method(_, _, _) =>
        # the body of a method contributes no *locally* bound vars
        nothing
      | j-ternary(test, consq, alt) =>
        e(test)
        e(consq)
        e(alt)
      | j-assign(_, rhs) => e(rhs)
      | j-bracket-assign(obj, field, rhs) =>
        e(obj)
        e(field)
        e(rhs)
      | j-dot-assign(obj, _, rhs) =>
        e(obj)
        e(rhs)
      | j-dot(obj, _) => e(obj)
      | j-bracket(obj, field)  =>
        e(obj)
        e(field)
      | j-list(_, elts) =>
        elts.each(e)
      | j-obj(fields) =>
        fields.each(f)
      | j-id(_) => nothing
      | j-str(_) => nothing
      | j-num(_) => nothing
      | j-true => nothing
      | j-false => nothing
      | j-null => nothing
      | j-undefined => nothing
      | j-label(_) => nothing
    end
  end
  fun c(shadow kase):
    cases(J.JCase) kase block:
      | j-case(exp, body) =>
        e(exp)
        b(body)
      | j-default(body) => b(body)
    end
  end
  fun f(field):
    e(field.value)
  end
  fun s(stmt):
    cases(J.JStmt) stmt block:
      | j-var(name, rhs) =>
        # Ignore all variables named $underscore#####
        if A.is-s-atom(name) and (name.base == "$underscore") block:
          e(rhs)
        else:
          e(rhs)
          vars.set-now(name.key(), name)
        end
      | j-if1(cond, consq) =>
        e(cond)
        b(consq)
      | j-if(cond, consq, alt) =>
        e(cond)
        b(consq)
        b(alt)
      | j-return(exp) => e(exp)
      | j-try-catch(body, exn, catch) =>
        b(body)
        # ignoring the exn name, because it's not a Pyret variable
        b(catch)
      | j-throw(exp) => e(exp)
      | j-expr(exp) => e(exp)
      | j-break => nothing
      | j-continue => nothing
      | j-switch(exp, branches) =>
        e(exp)
        branches.each(c)
      | j-while(cond, body) =>
        e(cond)
        b(body)
      | j-for(_, init, cond, update, body) =>
        e(init)
        e(cond)
        e(update)
        b(body)
    end
  end
  fun b(blk):
    cases(J.JBlock) blk:
      | j-block1(stmt) => s(stmt)
      | j-block(stmts) => stmts.each(s)
    end
  end
  c(kase)
  vars
end

fun copy-mutable-dict<E>(s :: D.MutableStringDict<E>) -> D.MutableStringDict<E>:
  s.freeze().unfreeze()
end

var total-time = 0


show-stack-trace = false
################################################################################
# Async backend control-flow core.
#
# Unlike the trampoline backend, ANF compiles almost directly to straight-line
# JS: the JS engine manages the stack, every Pyret function is an `async
# function`, every Pyret call is `await f.app(...)`, and a `checkPause()` fuel
# check sits at the top of each function. There is no $step switch, no
# activation records, and no GAS/Cont bouncing in the generated code.
#
# An AExpr is compiled by `compile-e(compiler, e, k)` where `k :: JExpr ->
# CList<JStmt>` is the *continuation* that consumes the value of `e`. `k` is
# always small (either `return v` or a single `x = v` assignment), so the
# control lettables (a-if / a-cases) push `k` into each branch without code
# blowup.
################################################################################

fun j-block-to-stmt-list(b :: J.JBlock) -> CL.ConcatList<J.JStmt>:
  cases (J.JBlock) b:
    | j-block(stmt-list) => stmt-list
    | j-block1(stmt) => cl-sing(stmt)
  end
end

fun is-id-fn-name(flatness-env :: D.MutableStringDict<Option<Number>>, name :: String) -> Boolean:
  flatness-env.has-key-now(name)
end

# A control lettable branches; its value cannot be expressed as a single JS
# expression, so we push the continuation into its branches.
fun is-control-lettable(e :: N.ALettable) -> Boolean:
  N.is-a-if(e) or N.is-a-cases(e)
end

# The variant-arity / singleton checker for a cases branch (reused verbatim from
# the trampoline backend's cases-preamble).
fun cases-preamble(compiler, compiled-val, branch, cases-loc):
  constructor-loc = j-dot(compiled-val, "$loc")
  cases(N.ACasesBranch) branch:
    | a-cases-branch(l2, pat-loc, name, args, body) =>
      branch-given-arity = j-num(args.length())
      obj-expected-arity = j-dot(compiled-val, "$arity")
      checker =
        j-if1(j-binop(obj-expected-arity, j-neq, branch-given-arity),
          j-block1(
            j-if(j-binop(obj-expected-arity, j-geq, j-num(0)),
              j-block1(
                j-expr(j-method(rt-field("ffi"), "throwCasesArityErrorC",
                    [clist: compiler.get-loc(l2), branch-given-arity,
                      obj-expected-arity, compiler.get-loc(cases-loc), constructor-loc]))),
              j-block1(
                j-expr(j-method(rt-field("ffi"), "throwCasesSingletonErrorC",
                    [clist: compiler.get-loc(l2), j-true, compiler.get-loc(cases-loc), constructor-loc]))))))
      [clist: checker]
    | a-singleton-cases-branch(l2, pat-loc, _, _) =>
      checker =
        j-if1(j-binop(j-dot(compiled-val, "$arity"), j-neq, j-num(-1)),
          j-block1(
            j-expr(j-method(rt-field("ffi"), "throwCasesSingletonErrorC",
                [clist: compiler.get-loc(l2), j-false, compiler.get-loc(cases-loc), constructor-loc]))))
      [clist: checker]
  end
end

# Annotation-check statements for a binding whose value already lives at
# `value-expr` (a j-id or j-bracket). Mirrors the trampoline's
# compile-annotated-let / compile-anns, but as straight-line `await
# R._checkAnn(...)` (which raises on failure, and may itself await a user
# predicate).
fun make-ann-stmts(compiler, bind :: N.ABind, value-expr :: J.JExpr) -> CL.ConcatList<J.JStmt>:
  if A.is-a-blank(bind.ann) or A.is-a-any(bind.ann):
    cl-empty
  else if A.is-a-tuple(bind.ann) and bind.ann.fields.all(lam(a): A.is-a-blank(a) or A.is-a-any(a) end):
    [clist:
      j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(bind.ann.l))),
      j-expr(rt-method("checkTupleBind", [clist: value-expr, j-num(bind.ann.fields.length()),
            compiler.get-loc(bind.ann.l)]))]
  else:
    compiled-ann = compile-ann(bind.ann, none, compiler)
    cl-append(compiled-ann.other-stmts,
      [clist:
        j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(bind.ann.l))),
        j-expr(j-await(rt-method("_checkAnn",
            [clist: compiler.get-loc(bind.ann.l), compiled-ann.exp, value-expr])))])
  end
end

# Declaration + binding + annotation check for an expression-valued lettable.
fun make-bind-stmts(compiler, b :: BindType, val :: J.JExpr) -> CL.ConcatList<J.JStmt>:
  cases(BindType) b:
    | b-let(bind) =>
      cl-cons(j-var(js-id-of(bind.id), val),
        make-ann-stmts(compiler, bind, j-id(js-id-of(bind.id))))
    | b-array(bind, idx) =>
      cl-cons(j-expr(j-bracket-assign(j-id(js-id-of(bind.id)), j-num(idx), val)),
        make-ann-stmts(compiler, bind, j-id(js-id-of(bind.id))))
  end
end

# The "declare the slot" statements for a control lettable bound to `b` (the
# value is assigned inside the branches).
fun bind-decl-stmts(b :: BindType) -> CL.ConcatList<J.JStmt>:
  cases(BindType) b:
    | b-let(bind) => cl-sing(j-var(js-id-of(bind.id), undefined))
    | b-array(_, _) => cl-empty
  end
end

# The continuation that assigns a branch's value into the slot for `b`.
fun bind-assign-k(b :: BindType) -> (J.JExpr -> CL.ConcatList<J.JStmt>):
  cases(BindType) b:
    | b-let(bind) => lam(val): cl-sing(j-expr(j-assign(js-id-of(bind.id), val))) end
    | b-array(bind, idx) => lam(val): cl-sing(j-expr(j-bracket-assign(j-id(js-id-of(bind.id)), j-num(idx), val))) end
  end
end

# Compile an expression-valued lettable to { prep-statements ; value-expression }.
fun compile-expr-lettable(compiler, e :: N.ALettable) -> { CL.ConcatList<J.JStmt>; J.JExpr }:
  cases(N.ALettable) e:
    | a-app(l, f, args, app-info) =>
      compiled-f = f.visit(compiler).exp
      compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
      is-safe-id = N.is-a-id(f) or N.is-a-id-safe-letrec(f)
      is-fn = is-safe-id and is-id-fn-name(compiler.flatness-env, f.id.key())
      guard = if not(is-fn):
          cl-sing(check-fun(l, j-id(compiler.cur-apploc), compiled-f))
        else:
          cl-empty
        end
      prep = cl-cons(j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l))), guard)
      { prep; j-await(app(l, compiled-f, compiled-args)) }
    | a-method-app(l, obj, methname, args) =>
      compiled-obj = obj.visit(compiler).exp
      compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
      argcount = compiled-args.length()
      helper-name = if argcount <= 7: "maybeMethodCall" + to-string(argcount) else: "maybeMethodCall" end
      if J.is-j-id(compiled-obj):
        call = wrap-with-srcnode(l,
          rt-method(helper-name,
            cl-append([clist: compiled-obj, j-str(methname), compiler.get-loc(l)], compiled-args)))
        { cl-sing(j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l)))); j-await(call) }
      else:
        obj-id = j-id(fresh-id(compiler-name("obj")))
        colon-field-id = j-id(fresh-id(compiler-name("field")))
        res-id = fresh-id(compiler-name("mres"))
        colon-field = rt-method("getColonFieldLoc", [clist: obj-id, j-str(methname), compiler.get-loc(l)])
        check-method = rt-method("isMethod", [clist: colon-field-id])
        prep = [clist:
          j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l))),
          j-var(obj-id.id, compiled-obj),
          j-var(colon-field-id.id, colon-field),
          j-var(res-id, undefined),
          j-if(check-method,
            j-block1(j-expr(j-assign(res-id,
                j-await(j-app(j-dot(colon-field-id, "full_meth"), cl-cons(obj-id, compiled-args)))))),
            j-block([clist:
                check-fun(l, compiler.get-loc(l), colon-field-id),
                j-expr(j-assign(res-id, j-await(wrap-with-srcnode(l, app(l, colon-field-id, compiled-args)))))]))]
        { prep; j-id(res-id) }
      end
    | a-prim-app(l, f, args, app-info) =>
      compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
      call = wrap-with-srcnode(l, rt-method(f, compiled-args))
      prep = cl-sing(j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l))))
      val = if app-info.needs-step: j-await(call) else: call end
      { prep; val }
    | a-update(l, obj, fields) =>
      compiled-obj = obj.visit(compiler).exp
      compiled-field-vals = CL.map_list(lam(fld): fld.value.visit(compiler).exp end, fields)
      field-names = CL.map_list(lam(fld): j-str(fld.name) end, fields)
      field-locs = CL.map_list(lam(fld): compiler.get-loc(fld.l) end, fields)
      call = rt-method("checkRefAnns",
        [clist: compiled-obj, j-list(false, field-names), j-list(false, compiled-field-vals),
          j-list(false, field-locs), compiler.get-loc(l), compiler.get-loc(obj.l)])
      { cl-empty; j-await(call) }
    | a-lam(l, name, args, ret, body) =>
      compiled-e = compile-a-lam(compiler, l, name, args, ret, body)
      { compiled-e.other-stmts; compiled-e.exp }
    | else =>
      compiled-e = e.visit(compiler)
      { compiled-e.other-stmts; compiled-e.exp }
  end
end

# Deliver the value of a lettable (expression or control) to continuation `k`.
fun compile-deliver(compiler, e :: N.ALettable, k :: (J.JExpr -> CL.ConcatList<J.JStmt>)) -> CL.ConcatList<J.JStmt>:
  cases(N.ALettable) e:
    | a-if(l, cond, consq, alt) =>
      compile-if(compiler, l, cond, consq, alt, k)
    | a-cases(l, typ, val, branches, _else) =>
      compile-cases(compiler, l, typ, val, branches, _else, k)
    | else =>
      { prep; val } = compile-expr-lettable(compiler, e)
      cl-append(prep, k(val))
  end
end

fun compile-if(compiler, l, cond :: N.AVal, consq :: N.AExpr, alt :: N.AExpr, k) -> CL.ConcatList<J.JStmt>:
  compiled-cond = cond.visit(compiler)
  cl-append(compiled-cond.other-stmts,
    cl-sing(j-if(rt-method("checkPyretTrue", [clist: compiled-cond.exp]),
        j-block(compile-e(compiler, consq, k)),
        j-block(compile-e(compiler, alt, k)))))
end

fun compile-cases-branch-async(compiler, compiled-val :: J.JExpr, branch :: N.ACasesBranch, cases-loc, k) -> CL.ConcatList<J.JStmt>:
  preamble = cases-preamble(compiler, compiled-val, branch, cases-loc)
  cases(N.ACasesBranch) branch:
    | a-cases-branch(l2, pat-loc, name, args, body) =>
      field-names = fresh-id(compiler-name("fn"))
      get-field-names = j-var(field-names, j-dot(j-dot(compiled-val, "$constructor"), "$fieldNames"))
      deref-fields =
        for CL.map_list_n(i from 0, arg from args):
          mask = j-bracket(j-dot(compiled-val, "$mut_fields_mask"), j-num(i))
          field = get-dict-field(compiled-val, j-bracket(j-id(field-names), j-num(i)))
          j-var(js-id-of(arg.bind.id),
            rt-method("derefField", [clist: field, mask, j-bool(A.is-s-cases-bind-ref(arg.field-type))]))
        end
      ann-stmts = for fold(acc from cl-empty, arg from args):
          cl-append(acc, make-ann-stmts(compiler, arg.bind, j-id(js-id-of(arg.bind.id))))
        end
      preamble
        ^ cl-snoc(_, get-field-names)
        ^ cl-append(_, deref-fields)
        ^ cl-append(_, ann-stmts)
        ^ cl-append(_, compile-e(compiler, body, k))
    | a-singleton-cases-branch(l2, pat-loc, _, body) =>
      cl-append(preamble, compile-e(compiler, body, k))
  end
end

fun compile-cases(compiler, cases-loc, typ, val :: N.AVal, branches :: List<N.ACasesBranch>, _else :: N.AExpr, k) -> CL.ConcatList<J.JStmt>:
  compiled-val = val.visit(compiler)
  cval-id = fresh-id(compiler-name("cases_val"))
  cval = j-id(cval-id)
  else-block = j-block(compile-e(compiler, _else, k))
  chain = for fold(acc from else-block, branch from branches.reverse()):
      test = j-binop(j-dot(cval, "$name"), j-eq, j-str(branch.name))
      body-block = j-block(compile-cases-branch-async(compiler, cval, branch, cases-loc, k))
      j-block1(j-if(test, body-block, acc))
    end
  compiled-val.other-stmts
    ^ cl-snoc(_, j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(cases-loc))))
    ^ cl-snoc(_, j-var(cval-id, compiled-val.exp))
    ^ cl-append(_, j-block-to-stmt-list(chain))
end

# Bind a lettable to `b`, then run `kont()` (the rest of the function).
fun compile-bind(compiler, b :: BindType, e :: N.ALettable, kont :: ( -> CL.ConcatList<J.JStmt>)) -> CL.ConcatList<J.JStmt>:
  if is-control-lettable(e):
    decl = bind-decl-stmts(b)
    deliver = compile-deliver(compiler, e, bind-assign-k(b))
    ann = make-ann-stmts(compiler, b.value, j-id(js-id-of(b.value.id)))
    decl ^ cl-append(_, deliver) ^ cl-append(_, ann) ^ cl-append(_, kont())
  else:
    { prep; val } = compile-expr-lettable(compiler, e)
    prep ^ cl-append(_, make-bind-stmts(compiler, b, val)) ^ cl-append(_, kont())
  end
end

# The core: compile an AExpr, delivering its value to `k`.
fun compile-e(compiler, e :: N.AExpr, k :: (J.JExpr -> CL.ConcatList<J.JStmt>)) -> CL.ConcatList<J.JStmt>:
  cases(N.AExpr) e:
    | a-lettable(_, lettable) =>
      compile-deliver(compiler, lettable, k)
    | a-let(_, b, lettable, body) =>
      compile-bind(compiler, b-let(b), lettable, lam(): compile-e(compiler, body, k) end)
    | a-arr-let(_, b, idx, lettable, body) =>
      compile-bind(compiler, b-array(b, idx), lettable, lam(): compile-e(compiler, body, k) end)
    | a-var(_, b, lettable, body) =>
      decl = j-var(js-id-of(b.id), j-obj([clist: j-field("$var", undefined)]))
      assign-k = lam(val): cl-sing(j-expr(j-dot-assign(j-id(js-id-of(b.id)), "$var", val))) end
      cl-cons(decl,
        cl-append(compile-deliver(compiler, lettable, assign-k),
          compile-e(compiler, body, k)))
    | a-seq(_, e1, e2) =>
      discard-k = lam(val): cl-sing(j-expr(val)) end
      cl-append(compile-deliver(compiler, e1, discard-k), compile-e(compiler, e2, k))
    | a-type-let(_, bind, body) =>
      cl-append(compile-type-bind(compiler, bind), compile-e(compiler, body, k))
  end
end

fun compile-type-bind(compiler, bind :: N.ATypeBind) -> CL.ConcatList<J.JStmt>:
  cases(N.ATypeBind) bind:
    | a-type-bind(l2, name, ann) =>
      compiled-ann = compile-ann(ann, some(name.toname()), compiler)
      cl-snoc(compiled-ann.other-stmts, j-var(js-id-of(name), compiled-ann.exp))
    | a-newtype-bind(l2, name, nameb) =>
      brander-id = js-id-of(nameb)
      [clist:
        j-var(brander-id, rt-method("namedBrander", [clist: j-str(name.toname()), compiler.get-loc(l2)])),
        j-var(js-id-of(name), rt-method("makeBranderAnn", [clist: j-id(brander-id), j-str(name.toname())]))]
  end
end

# An async function body: declare apploc, arity-check, await checkPause, copy
# formals, check argument annotations, then the body (ending in `return`).
fun compile-fun-body(l :: Loc, compiler, args :: List<N.ABind>, opt-arity :: Option<Number>, body :: N.AExpr, is-method :: Boolean) -> J.JBlock block:
  apploc = fresh-id(compiler-name("al"))
  local-compiler = compiler.{cur-apploc: apploc, args: args.map(_.id).map(js-id-of)}
  formal-args = for map(arg from args):
      N.a-bind(arg.l, formal-shadow-name(arg.id), arg.ann)
    end
  no-real-args = (args.first.id == compiler.resumer)
  copy-formals-to-args =
    if no-real-args: cl-empty
    else:
      for CL.map_list2(formal-arg from formal-args, arg from args):
        j-var(js-id-of(arg.id), j-id(formal-arg.id))
      end
    end
  arity-stmts = cases(Option) opt-arity:
    | some(arity) => arity-check(local-compiler.get-loc(l), arity, is-method)
    | none => cl-empty
  end
  arg-ann-stmts =
    if no-real-args: cl-empty
    else:
      for fold(acc from cl-empty, arg from args):
        cl-append(acc, make-ann-stmts(local-compiler, arg, j-id(js-id-of(arg.id))))
      end
    end
  check-pause = cl-sing(j-expr(j-await(rt-method("checkPause", cl-empty))))
  body-stmts = compile-e(local-compiler, body, lam(val): cl-sing(j-return(val)) end)
  j-block(
    cl-cons(j-var(apploc, local-compiler.get-loc(l)),
      arity-stmts
        ^ cl-append(_, check-pause)
        ^ cl-append(_, copy-formals-to-args)
        ^ cl-append(_, arg-ann-stmts)
        ^ cl-append(_, body-stmts)))
end

fun compile-a-lam(compiler, l :: Loc, name :: String, args :: List<N.ABind>, ret :: A.Ann, body :: N.AExpr) block:
  temp = fresh-id(compiler-name("temp_lam"))
  len = args.length()
  # NOTE: args may be empty, so we need at least one name ("resumer") for the convention
  effective-args =
    if len > 0: args
    else: [list: N.a-bind(l, compiler.resumer, A.a-blank)]
    end
  c-exp(
    rt-method("makeFunction", [clist: j-id(temp), j-str(name)]),
    [clist:
      j-var(temp,
        j-fun-async(J.next-j-fun-id(), make-fun-name(compiler, l),
          CL.map_list(lam(arg): formal-shadow-name(arg.id) end, effective-args),
          compile-fun-body(l, compiler, effective-args, some(len), body, false)))])
end


compiler-visitor = {
  method a-module(self, l, answer, dms, dvs, dts, checks):

    mp-specs = self.prog-provides.specs.filter(A.is-s-provide-module)
    vp-specs = self.prog-provides.specs.filter(A.is-s-provide-name)
    tp-specs = self.prog-provides.specs.filter(A.is-s-provide-type)
    dp-specs = self.prog-provides.specs.filter(A.is-s-provide-data)

    {alias-fields; alias-stmts} = for fold(acc from {cl-empty; cl-empty}, tp from tp-specs):
      cases(A.NameSpec) tp.name-spec:
        | s-local-ref(_, name, as-name) =>
          compiled = compile-ann(A.a-name(l, name), none, self) # TODO(Ben): should be none, or name, or as-name?
          {
            cl-snoc(acc.{0}, j-field(as-name.toname(), compiled.exp));
            cl-append(acc.{1}, compiled.other-stmts)
          }
        | s-remote-ref(_, uri, name, as-name) =>
          {
            cl-snoc(acc.{0},
              j-field(as-name.toname(), 
                  get-module-field(uri, "types", name.toname())));
            acc.{1}
          }
      end
    end


    compiled-provides = for CL.map_list(pv from vp-specs):
      cases(A.NameSpec) pv.name-spec:
        | s-local-ref(_, name, as-name) =>
          val-bind = self.bindings.get-value-now(name.key())
          val-exp = cases(CS.ValueBinder) val-bind.binder:
            | vb-letrec => j-dot(j-id(js-id-of(name)), "$var")
            | vb-var => j-id(js-id-of(name))
            | vb-let => j-id(js-id-of(name))
          end
          j-field(as-name.toname(), val-exp)
        | s-remote-ref(_, uri, name, as-name) =>
          val-exp = get-module-field(uri, "values", name.toname())
          
          j-field(as-name.toname(), val-exp)
      end
    end

    {types-fields; types-stmts} = {
      alias-fields; #+ data-fields;
      alias-stmts; #+ data-stmts
    }

    compiled-module-provides = for CL.map_list(pm from mp-specs):
      cases(A.NameSpec) pm.name-spec:
        | s-local-ref(_, name, as-name) =>
          compiled = j-id(js-id-of(name))
          j-field(as-name.toname(), compiled)
        | s-remote-ref(_, uri, name, as-name) =>
          j-field(as-name.toname(), j-bracket(rt-field("modules"), j-str(uri)))
      end
    end


    compiled-answer = answer.visit(self)
    compiled-checks = checks.visit(self)
    c-exp(
      rt-method("makeObject", [clist:
          j-obj([clist:
              j-field("answer", compiled-answer.exp),
              j-field("namespace", NAMESPACE),
              j-field("locations", j-id(const-id("L"))),
              j-field("defined-modules",
                j-obj(
                  for CL.map_list(dm from dms):
                    j-field(dm.name, j-id(js-id-of(dm.value)))
                  end)),
              j-field("defined-values",
                j-obj(
                  for CL.map_list(dv from dvs):
                    cases(N.ADefinedValue) dv:
                      | a-defined-value(name, value) =>
                        compiled-val = dv.value.visit(self).exp
                        j-field(dv.name, compiled-val)
                      | a-defined-var(name, id) =>
                        j-field(dv.name, j-id(js-id-of(id)))
                    end
                  end)),
              j-field("defined-types",
                j-obj(
                  for CL.map_list(dt from dts):
                    compiled-ann = compile-ann(dt.typ, none, self).exp
                    j-field(dt.name, compiled-ann)
                  end)),
              j-field("provide-plus-types",
                rt-method("makeObject", [clist: j-obj([clist:
                        j-field("values", rt-method("makeObject", [clist: j-obj(compiled-provides)])),
                        j-field("types", j-obj(types-fields)),
                        j-field("modules", j-obj(compiled-module-provides))
                    ])])),
              j-field("checks", compiled-checks.exp)])]),

      types-stmts ^
      cl-append(_, compiled-answer.other-stmts) ^
      cl-append(_, compiled-checks.other-stmts))
  end,
  # The async backend traverses AExprs with compile-e, not the visitor, so the
  # structural and control methods are never reached via .visit. They remain as
  # guards. (The AVal / expression-lettable methods below ARE reached via
  # .visit and produce c-exp values reused verbatim from the trampoline backend.)
  method a-type-let(self, l, bind, body):
    raise("Impossible: a-type-let directly in async compiler-visitor should never happen")
  end,
  method a-let(self, _, b :: N.ABind, e :: N.ALettable, body :: N.AExpr):
    raise("Impossible: a-let directly in async compiler-visitor should never happen")
  end,
  method a-arr-let(self, _, b :: N.ABind, idx :: Number, e :: N.ALettable, body :: N.AExpr):
    raise("Impossible: a-arr-let directly in async compiler-visitor should never happen")
  end,
  method a-var(self, l :: Loc, b :: N.ABind, e :: N.ALettable, body :: N.AExpr):
    raise("Impossible: a-var directly in async compiler-visitor should never happen")
  end,
  method a-seq(self, _, e1, e2):
    raise("Impossible: a-seq directly in async compiler-visitor should never happen")
  end,
  method a-if(self, l :: Loc, cond :: N.AVal, consq :: N.AExpr, alt :: N.AExpr):
    raise("Impossible: a-if directly in compiler-visitor should never happen")
  end,
  method a-cases(self, l :: Loc, typ :: A.Ann, val :: N.AVal, branches :: List<N.ACasesBranch>, _else :: N.AExpr):
    raise("Impossible: a-cases directly in compiler-visitor should never happen")
  end,
  method a-update(self, l, obj, fields):
    raise("Impossible: a-update directly in compiler-visitor should never happen")
  end,
  method a-lettable(self, _, e :: N.ALettable):
    raise("Impossible: a-lettable directly in async compiler-visitor should never happen")
  end,
  method a-assign(self, l :: Loc, id :: A.Name, value :: N.AVal):
    visit-value = value.visit(self)
    c-exp(rt-field("nothing"), cl-snoc(visit-value.other-stmts, j-expr(j-dot-assign(j-id(js-id-of(id)), "$var", visit-value.exp))))
  end,
  method a-app(self, l :: Loc, f :: N.AVal, args :: List<N.AVal>):
    raise("Impossible: a-app directly in compiler-visitor should never happen")
  end,
  method a-prim-app(self, l :: Loc, f :: String, args :: List<N.AVal>, app-info :: A.PrimAppInfo):
    visit-args = args.map(_.visit(self))
    set-loc = [clist:
      j-expr(j-assign(self.cur-apploc, self.get-loc(l)))
    ]
    c-exp(rt-method(f, CL.map_list(get-exp, visit-args)), set-loc)
  end,

  method a-ref(self, l, maybe-ann):
    cases(Option) maybe-ann:
      | none => c-exp(rt-method("makeGraphableRef", cl-empty), cl-empty)
      | some(ann) => raise("Cannot handle annotations in refs yet")
    end
  end,
  method a-obj(self, l :: Loc, fields :: List<N.AField>):
    visit-fields = fields.map(lam(f): f.visit(self) end)
    c-exp(rt-method("makeObject", [clist: j-obj(CL.map_list(o-get-field, visit-fields))]), cl-empty)
  end,
  method a-get-bang(self, l :: Loc, obj :: N.AVal, field :: String):
    visit-obj = obj.visit(self)
    c-exp(rt-method("getFieldRef", [clist: visit-obj.exp, j-str(field), self.get-loc(l)]), visit-obj.other-stmts)
  end,
  method a-extend(self, l :: Loc, obj :: N.AVal, fields :: List<N.AField>):
    visit-obj = obj.visit(self)
    visit-fields = fields.map(lam(f): f.visit(self) end)
    c-exp(rt-method("extendObj", [clist: self.get-loc(l), visit-obj.exp, j-obj(CL.map_list(o-get-field, visit-fields))]),
      cl-empty)
  end,
  method a-dot(self, l :: Loc, obj :: N.AVal, field :: String):
    visit-obj = obj.visit(self)
    c-exp(get-field-safe(l, visit-obj.exp, j-str(field), self.get-loc(l)),
      cl-snoc(visit-obj.other-stmts, j-expr(j-assign(self.cur-apploc, self.get-loc(l)))))
  end,
  method a-colon(self, l :: Loc, obj :: N.AVal, field :: String):
    visit-obj = obj.visit(self)
    c-exp(rt-method("getColonFieldLoc", [clist: visit-obj.exp, j-str(field), self.get-loc(l)]),
      visit-obj.other-stmts)
  end,
  method a-method(self, l :: Loc, name :: String, args :: List<N.ABind>, ret :: A.Ann, body :: N.AExpr):
    temp-full = fresh-id(compiler-name("temp_full"))
    len = args.length()
    full-var =
      j-var(temp-full,
        j-fun-async(J.next-j-fun-id(), make-fun-name(self, l),
          CL.map_list(lam(a): formal-shadow-name(a.id) end, args),
          compile-fun-body(l, self, args, some(len), body, true)
        ))
    method-expr = if len < 9:
      rt-method(string-append("makeMethod", tostring(len - 1)), [clist: j-id(temp-full), j-str(name)])
    else:
      rt-method("makeMethodN", [clist: j-id(temp-full), j-str(name)])
    end
    c-exp(method-expr, [clist: full-var])
  end,
  method a-val(self, l :: Loc, v :: N.AVal):
    v.visit(self)
  end,
  method a-field(self, l :: Loc, name :: String, value :: N.AVal):
    visit-v = value.visit(self)
    c-field(j-field(name, visit-v.exp), visit-v.other-stmts)
  end,
  method a-tuple(self, l, values):
    visit-vals = values.map(_.visit(self))
    c-exp(rt-method("makeTuple", [clist: j-list(false, CL.map_list(get-exp, visit-vals))]), cl-empty)
  end,
  method a-tuple-get(self, l, tup, index):
   visit-name = tup.visit(self)
    c-exp(rt-method("getTuple", [clist: visit-name.exp, j-num(index), self.get-loc(l)]), cl-empty)
  end,
  method a-array(self, l, values):
    visit-vals = values.map(_.visit(self))
    other-stmts = visit-vals.foldr(lam(v, acc): cl-append(v.other-stmts, acc) end, cl-empty)
    c-exp(j-list(false, CL.map_list(get-exp, visit-vals)), other-stmts)
  end,
  method a-srcloc(self, l, loc):
    c-exp(self.get-loc(loc), cl-empty)
  end,
  method a-num(self, l :: Loc, n :: Number):
    if num-is-fixnum(n):
      c-exp(j-parens(j-num(n)), cl-empty)
    else:
      c-exp(rt-method("makeNumberFromString", [clist: j-str(tostring(n))]), cl-empty)
    end
  end,
  method a-str(self, l :: Loc, s :: String):
    c-exp(j-parens(j-str(s)), cl-empty)
  end,
  method a-bool(self, l :: Loc, b :: Boolean):
    c-exp(j-parens(if b: j-true else: j-false end), cl-empty)
  end,
  method a-undefined(self, l :: Loc):
    c-exp(undefined, cl-empty)
  end,
  method a-prim-val(self, l :: Loc, name :: String):
    c-exp(rt-field(name), cl-empty)
  end,
  method a-id(self, l :: Loc, id :: A.Name):
    c-exp(j-id(js-id-of(id)), cl-empty)
  end,
  method a-id-modref(self, l :: Loc, id :: A.Name, uri :: String, name :: String):
    c-exp(
      j-bracket(
        j-dot(
          j-dot(
            j-dot(j-id(js-id-of(id)), "dict"),
            "values"),
          "dict"),
        j-str(name)), cl-empty)
  end,
  method a-id-var-modref(self, l :: Loc, id :: A.Name, uri :: String, name :: String):
    c-exp(
      j-dot(j-bracket(
        j-dot(
          j-dot(
            j-dot(j-id(js-id-of(id)), "dict"),
            "values"),
          "dict"),
        j-str(name)), "$var"), cl-empty)
  end,
  method a-id-var(self, l :: Loc, id :: A.Name):
    c-exp(j-dot(j-id(js-id-of(id)), "$var"), cl-empty)
  end,
  method a-id-safe-letrec(self, l :: Loc, id :: A.Name):
    s = j-id(js-id-of(id))
    c-exp(j-dot(s, "$var"), cl-empty)
  end,
  method a-id-letrec(self, l :: Loc, id :: A.Name, safe :: Boolean):
    s = j-id(js-id-of(id))
    if safe:
      c-exp(j-dot(s, "$var"), cl-empty)
    else:
      c-exp(
        j-ternary(
          j-binop(j-dot(s, "$var"), j-eq, undefined),
          raise-id-exn(self.get-loc(l), id.toname()),
          j-dot(s, "$var")),
        cl-empty)
    end
  end,

  method a-data-expr(self, l, name, namet, variants, shared):
    fun brand-name(base):
      js-id-of(compiler-name(string-append("brand-", base))).toname()
    end

    visit-shared-fields = CL.map_list(_.visit(self), shared)
    shared-fields = visit-shared-fields.map(o-get-field)
    external-brand = j-id(js-id-of(namet))

    fun make-brand-predicate(loc :: Loc, b :: J.JExpr, pred-name :: String):
      val = fresh-id(compiler-name("val"))
      j-field(
        pred-name,
        rt-method("makeFunction", [clist:
            j-fun(J.next-j-fun-id(),
              make-fun-name(self, l),
              [clist: val],
              j-block(
                cl-snoc(
                  arity-check(self.get-loc(loc), 1, false),
                  j-return(rt-method("makeBoolean", [clist: rt-method("hasBrand", [clist: j-id(val), b])])))
                )
              ),
            j-str(pred-name + "-Tester")
          ])
        )
    end

    fun make-variant-constructor(l2, base-id, brands-id, members, refl-name, refl-ref-fields-mask, refl-fields, constructor-id):

      nonblank-anns = for filter(m from members):
        not(A.is-a-blank(m.bind.ann)) and not(A.is-a-any(m.bind.ann))
      end
      compiled-anns = for fold(acc from {anns: cl-empty, others: cl-empty}, m from nonblank-anns):
        compiled = compile-ann(m.bind.ann, none, self)
        {
          anns: cl-snoc(acc.anns, compiled.exp),
          others: cl-append(acc.others, compiled.other-stmts)
        }
      end
      compiled-locs = for CL.map_list(m from nonblank-anns): self.get-loc(m.bind.ann.l) end
      compiled-vals = for CL.map_list(m from nonblank-anns): j-str(js-id-of(m.bind.id).tosourcestring()) end

      # NOTE(joe 6-14-2014): We cannot currently statically check for if an annotation
      # is a refinement because of type aliases.  So, we use checkAnnArgs, which takes
      # a continuation and manages all of the stack safety of annotation checking itself.

      # NOTE(joe 5-26-2015): This has been moved to a hybrid static/dynamic solution by
      # passing the check off to a runtime function that uses JavaScript's Function
      # to only do the refinement check once.
      c-exp(
        rt-method("makeVariantConstructor", [clist:
            self.get-loc(l2),
            # NOTE(joe): Thunked at the JS level because compiled-anns might contain
            # references to rec ids that should be resolved later
            j-fun(J.next-j-fun-id(), "$synthesizedConstructor_" + base-id.toname(), cl-empty, j-block1(j-return(j-list(false, compiled-anns.anns)))),
            j-list(false, compiled-vals),
            j-list(false, compiled-locs),
            j-list(false, CL.map_list(lam(m): j-bool(N.is-a-mutable(m.member-type)) end, members)),
            j-list(false, CL.map_list(lam(m): j-str(js-id-of(m.bind.id).tosourcestring()) end, members)),
            refl-ref-fields-mask,
            j-id(base-id),
            j-id(brands-id),
            refl-name,
            refl-fields,
            constructor-id
          ]),
        cl-empty)
    end

    fun compile-variant(v :: N.AVariant):
      vname = v.name
      variant-base-id = js-id-of(compiler-name(string-append(vname, "-base")))
      variant-brand = rt-method("namedBrander", [clist: j-str(vname), self.get-loc(v.l)])
      variant-brand-id = js-id-of(compiler-name(string-append(vname, "-brander")))
      variant-brand-obj-id = js-id-of(compiler-name(string-append(vname, "-brands")))
      variant-brands = j-obj(cl-empty)
      visit-with-fields = v.with-members.map(_.visit(self))

      refl-base-fields =
        cases(N.AVariant) v:
          | a-singleton-variant(_, _, _) => cl-empty
          | a-variant(_, _, _, members, _) =>
            [clist:
              j-field("$fieldNames",
                j-list(false, CL.map_list(lam(m): j-str(m.bind.id.toname()) end, members)))]
        end

      f-id = const-id("f")
      refl-name = j-str(vname)

      refl-ref-fields-mask-id = js-id-of(compiler-name(string-append(vname, "_mutablemask")))
      refl-ref-fields-mask =
        cases(N.AVariant) v:
          | a-singleton-variant(_, _, _) => j-list(false, cl-empty)
          | a-variant(_, _, _, members, _) =>
            j-list(false,
              CL.map_list(lam(m): if N.is-a-mutable(m.member-type): j-true else: j-false end end, members))
        end

      refl-fields-id = js-id-of(compiler-name(string-append(vname, "_getfields")))
      refl-fields =
        cases(N.AVariant) v:
          | a-variant(_, _, _, members, _) =>
            j-fun(J.next-j-fun-id(), "singleton_variant",
              [clist: const-id("f")], j-block1(j-return(j-app(j-id(f-id),
                    CL.map_list(lam(m):
                        get-dict-field(THIS, j-str(m.bind.id.toname()))
                      end, members)))))
          | a-singleton-variant(_, _, _) =>
            j-fun(J.next-j-fun-id(), "variant",
              [clist: const-id("f")], j-block1(j-return(j-app(j-id(f-id), cl-empty))))
        end

      fun member-count(shadow v):
        cases(N.AVariant) v:
          | a-variant(_, _, _, members, _) => members.length()
          | a-singleton-variant(_, _, _) => 0
        end
      end

      match-field = j-field("_match", rt-method("makeMatch", [clist: refl-name, j-num(member-count(v))]))

      stmts =
        visit-with-fields.foldr(lam(vf, acc): cl-append(vf.other-stmts, acc) end,
          [clist:
            j-var(refl-fields-id, refl-fields),
            j-var(refl-ref-fields-mask-id, refl-ref-fields-mask),
            j-var(variant-base-id, j-obj(refl-base-fields + shared-fields + CL.map_list(o-get-field, visit-with-fields) + [clist: match-field])),
            j-var(variant-brand-id, variant-brand),
            j-var(variant-brand-obj-id, variant-brands),
            j-expr(j-bracket-assign(
                j-id(variant-brand-obj-id),
                j-dot(external-brand, "_brand"),
                j-true)),
            j-expr(j-bracket-assign(
                j-id(variant-brand-obj-id),
                j-dot(j-id(variant-brand-id), "_brand"),
                j-true))
          ])
      predicate = j-field(A.make-checker-name(vname), get-field-unsafe(j-id(variant-brand-id), j-str("test"), self.get-loc(v.l))) #make-brand-predicate(v.l, j-dot(j-id(variant-brand-id), "_brand"), A.make-checker-name(vname))

      cases(N.AVariant) v:
        | a-variant(l2, constr-loc, _, members, with-members) =>
          constr-vname = js-id-of(const-id(vname))
          compiled-constr =
            make-variant-constructor(l2, variant-base-id, variant-brand-obj-id, members,
              refl-name, j-id(refl-ref-fields-mask-id), j-id(refl-fields-id), j-id(variant-base-id))
          {
            stmts: stmts ^
              cl-append(_,compiled-constr.other-stmts) ^
              cl-snoc(_, j-var(constr-vname, compiled-constr.exp)),
            constructor: j-field(vname, j-id(constr-vname)),
            predicate: predicate
          }
        | a-singleton-variant(l2, _, with-members) =>
          {
            stmts: stmts,
            constructor: j-field(vname, rt-method("makeDataValue", [clist: j-id(variant-base-id), j-id(variant-brand-obj-id), refl-name, j-id(refl-fields-id), j-num(-1), j-id(refl-ref-fields-mask-id), j-id(variant-base-id), j-false, self.get-loc(l2)])),
            predicate: predicate
          }
      end
    end

    variant-pieces = variants.map(compile-variant)

    header-stmts = for fold(acc from cl-empty, piece from variant-pieces):
      cl-append(acc, piece.stmts)
    end
    obj-fields = for fold(acc from cl-empty, piece from variant-pieces):
      cl-append(acc, [clist: piece.predicate, piece.constructor])
    end

    data-predicate = j-field(name, get-field-unsafe(external-brand, j-str("test"), self.get-loc(l))) #make-brand-predicate(l, j-dot(external-brand, "_brand"), name)

    data-object = rt-method("makeObject", [clist: j-obj(cl-cons(data-predicate, obj-fields))])

    c-exp(data-object, header-stmts)
  end
}

#|
remove-useless-if-visitor = N.default-map-visitor.{
  method a-if(self, l, c, t, e):
    cases(N.AVal) c:
      | a-bool(_, test) =>
        if test:
          visit-t = t.visit(self)
          if N.is-a-lettable(visit-t): visit-t.e else: N.a-if(l, c, visit-t, N.a-lettable(e.l, N.a-undefined(e.l))) end
        else:
          visit-e = e.visit(self)
          if N.is-a-lettable(visit-e): visit-e.e else: N.a-if(l, c, N.a-lettable(t.l, N.a-undefined(t.l)), visit-e) end
        end
      | else => N.a-if(l, c.visit(self), t.visit(self), e.visit(self))
    end
  end
}

check:
  d = N.dummy-loc
  true1 = N.a-if(d, N.a-bool(d, true),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 1))),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 2))))
  true1.visit(remove-useless-if-visitor) is N.a-val(d, N.a-num(d, 1))

  false4 = N.a-if(d, N.a-bool(d, false),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 3))),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 4))))
  false4.visit(remove-useless-if-visitor) is N.a-val(d, N.a-num(d, 4))

  N.a-if(d, N.a-id(d, A.s-name(d, "x")), N.a-lettable(d, true1), N.a-lettable(d, false4)
    ).visit(remove-useless-if-visitor)
    is N.a-if(d, N.a-id(d, A.s-name(d, "x")),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 1))),
    N.a-lettable(d, N.a-val(d, N.a-num(d, 4))))

end
|#

fun mk-abbrevs(l):
  loc = const-id("loc")
  name = const-id("name")
  [clist:
    j-var(const-id("G"), rt-field("getFieldLoc")),
    j-var(const-id("U"), j-fun(J.next-j-fun-id(), "throw_error", [clist: loc, name],
        j-block1(j-expr(j-method(rt-field("ffi"), "throwUninitializedIdMkLoc",
            [clist: j-id(loc), j-id(name)]))))),
    j-var(const-id("M"), j-str(l.source)),
    j-var(const-id("D"), rt-field("undefined"))
  ]
end

fun import-key(i): AU.import-to-dep(i).key() end

fun compile-type-variant(variant):
  cases(T.TypeVariant) variant:
    | t-variant(name, members, with-members, l) =>
      compiled-members = j-list(false, CL.map_list(lam({mem-name; typ}):
          if T.is-t-ref(typ):
            j-list(true, [clist: j-str("ref"), j-str(mem-name), compile-provided-type(typ.typ)])
          else:
            j-list(true, [clist: j-str(mem-name), compile-provided-type(typ)])
          end
        end, members))
      compiled-with-members = j-obj(for cl-map-sd(mem-name from with-members):
            compile-type-member(mem-name, with-members.get-value(mem-name))
          end)
      j-list(true, [clist: j-str(name), compiled-members, compiled-with-members])
    | t-singleton-variant(name, with-members, l) =>
      compiled-with-members = j-obj(for cl-map-sd(mem-name from with-members):
          compile-type-member(mem-name, with-members.get-value(mem-name))
        end)
      j-list(true, [clist: j-str(name), compiled-with-members])
  end
end

fun compile-type-member(name, typ):
  j-field(name, compile-provided-type(typ))
end

fun compile-provided-data(de :: CS.DataExport):
  cases(CS.DataExport) de: 
    | d-alias(origin, name) =>
      j-list(false,
        [clist: j-str("data-alias"),
          compile-origin(origin),
          j-str(name)])
    | d-type(origin, typ) =>
      cases(T.DataType) typ:
        | t-data(name, params, variants, members, l) =>
          j-list(false,
            [clist: j-str("data"),
              compile-origin(origin),
              j-str(name),
              j-list(false, for CL.map_list(p from params):
                  j-str(p.id.key())
                end),
              j-list(false, CL.map_list(compile-type-variant, variants)),
              j-obj(for cl-map-sd(mem-name from members):
                compile-type-member(mem-name, members.get-value(mem-name))
              end)])
    end
  end
end

fun compile-provided-type(typ):
  cases(T.Type) typ:
    | t-name(mod-name, id, l, _) =>
      cases(T.NameOrigin) mod-name:
        | local => j-obj([clist:
              j-field("tag", j-str("name")),
              j-field("origin", j-obj([clist: j-field("import-type", j-str("$ELF"))])),
              j-field("name", j-str(id.toname()))]) # TODO: toname or key?
        | module-uri(uri) =>
          j-obj([clist:
              j-field("tag", j-str("name")),
              j-field("origin", j-obj([clist: j-field("import-type", j-str("uri")), j-field("uri", j-str(uri))])),
              j-field("name", j-str(id.toname()))]) # TODO: toname or key?
        | dependency(dep) =>
          raise("Dependency-origin names in provided-types shouldn't be possible")
      end
    | t-var(name, l, _) => j-list(true, [clist: j-str("tid"), j-str(name.key())]) # NOTE(joe): changed to .key()
    | t-arrow(args, ret, l, _) =>
      j-list(true,
        [clist: j-str("arrow"),
          j-list(true, CL.map_list(compile-provided-type, args)), compile-provided-type(ret)])
    | t-app(base, args, l, _) =>
      j-list(false,
        [clist: j-str("tyapp"), compile-provided-type(base),
          j-list(true, CL.map_list(compile-provided-type, args))])
    | t-top(_, _) => j-str("tany")
    | t-bot(_, _) => j-str("tbot")
    | t-record(fields, l, _) =>
      j-list(false,
        [clist: j-str("record"), j-obj(for cl-map-sd(key from fields):
              compile-type-member(key, fields.get-value(key))
            end)])
    | t-tuple(elts, l, _) =>
      j-list(false,
        [clist: j-str("tuple"), j-list(false, CL.map_list(compile-provided-type, elts))])
    | t-forall(params, body, l, _) =>
      j-list(true,
        [clist: j-str("forall"),
          j-list(false, for CL.map_list(p from params):
            j-str(p.id.key())
          end), compile-provided-type(body)])
      # | t-ref(_, _) =>
      # | t-existential(_, _) =>
    | t-data-refinement(base-typ, variant-name, l, _) =>
      j-list(true,
        [clist: j-str("data%"), compile-provided-type(base-typ), j-str(variant-name)])
    | else => j-ternary(j-false, j-str(tostring(typ)), j-str("tany"))
  end
end

fun srcloc-to-raw(l):
  cases(SL.Srcloc) l:
    | builtin(uri) => j-list(true, [clist: j-str(uri)])
    | srcloc(uri, sl, sc, si, el, ec, ei) =>
      j-list(true, [clist: j-str(uri), j-num(sl), j-num(sc), j-num(si), j-num(el), j-num(ec), j-num(ei)])
  end
end

fun compile-origin(bo):
  j-obj([clist:
    j-field("local-bind-site", srcloc-to-raw(bo.local-bind-site)),
    j-field("definition-bind-site", srcloc-to-raw(bo.definition-bind-site)),
    j-field("new-definition", j-bool(bo.new-definition)),
    j-field("uri-of-definition", j-str(bo.uri-of-definition))
  ])
end

fun compile-provides(provides):
  cases(CS.Provides) provides:
    | provides(thismod-uri, modules, values, aliases, data-defs) =>
      module-fields = for cl-map-sd(m from modules):
        j-field(m, j-obj([clist: j-field("uri", j-str(modules.get-value(m)))]))
      end
      value-fields = for cl-map-sd(v from values):
        cases(CS.ValueExport) values.get-value(v):
          | v-alias(origin, name) =>
            j-field(v, j-obj([clist:
              j-field("bind", j-str("alias")),
              j-field("origin", compile-origin(origin)),
              j-field("original-name", j-str(name)),
              j-field("typ", j-bool(false))
            ]))
          | v-just-type(origin, t) => j-field(v, j-obj([clist:
              j-field("bind", j-str("let")),
              j-field("origin", compile-origin(origin)),
              j-field("typ", compile-provided-type(t))
            ]))
          | v-var(origin, t) => j-field(v, j-obj([clist:
              j-field("bind", j-str("var")),
              j-field("origin", compile-origin(origin)),
              j-field("typ", compile-provided-type(t))
            ]))
          | v-fun(origin, t, name, flatness) =>
            j-field(v, j-obj([clist:
              j-field("bind", j-str("fun")),
              j-field("origin", compile-origin(origin)),
              j-field("flatness", flatness.and-then(j-num).or-else(j-false)),
              j-field("name", j-str(name)),
              j-field("typ", compile-provided-type(t))
            ]))
        end
      end
      data-fields = for cl-map-sd(d from data-defs):
        j-field(d, compile-provided-data(data-defs.get-value(d)))
      end
      alias-fields = for cl-map-sd(a from aliases):
        j-field(a, compile-provided-type(aliases.get-value(a)))
      end
      j-obj([clist:
          j-field("modules", j-obj(module-fields)),
          j-field("values", j-obj(value-fields)),
          j-field("datatypes", j-obj(data-fields)),
          j-field("aliases", j-obj(alias-fields))
        ])
  end
end

fun compile-module(self, l, prog-provides, imports-in, prog, freevars, provides, env) block:
  js-names.reset()
  shadow freevars = freevars.unfreeze()

  imports = imports-in.filter(A.is-s-import).sort-by(
      lam(i1, i2): import-key(i1.file) < import-key(i2.file)  end,
      lam(i1, i2): import-key(i1.file) == import-key(i2.file) end
    )

  for each(i from imports) block:
    cases(A.Import) i:
      | s-import(_, _, mod-name) =>
        freevars.remove-now(mod-name.key())
      | else => nothing
    end
  end

  free-ids = freevars.map-keys-now(freevars.get-value-now(_))
  module-and-global-binds = lists.partition(A.is-s-atom, free-ids)
  global-binds = for CL.map_list(n from module-and-global-binds.is-false):
    { maybe-origin; which } =
      cases(A.Name) n:
        | s-module-global(s) =>
          { env.origin-by-module-name(n.toname()); "modules"}
        | s-global(s) =>
          { env.origin-by-value-name(n.toname()); "values"}
        | s-type-global(s) =>
          { env.origin-by-type-name(n.toname()); "types"}
      end

    { uri; name } = cases(Option) maybe-origin:
      | some(origin) => { origin.uri-of-definition; origin.original-name.toname() }
      | none => raise(n.toname() + " not found")
    end

    j-var(js-id-of(n), get-module-field(uri, which, name))
  end
  # MARK(joe): need to do something below for modules that come from
  # a context like "include"
  module-binds = for CL.map_list(n from module-and-global-binds.is-true):
    { which; uri; lookup-name } = ask:
      | self.bindings.has-key-now(n.key()) then:
        val-bind = self.bindings.get-value-now(n.key())
        { "values"; val-bind.origin.uri-of-definition; val-bind.origin.original-name }
      | self.type-bindings.has-key-now(n.key()) then:
        typ-bind = self.type-bindings.get-value-now(n.key())
        { "types"; typ-bind.origin.uri-of-definition; typ-bind.origin.original-name }
      | self.module-bindings.has-key-now(n.key()) then:
        mod-bind = self.module-bindings.get-value-now(n.key())
        { "modules"; mod-bind.origin.uri-of-definition; mod-bind.origin.original-name }
    end
    j-var(js-id-of(n), get-module-field(uri, which, lookup-name.toname()))
  end
  fun clean-import-name(name):
    js-id-of(name)
    #|if A.is-s-atom(name) and (name.base == "$import"): fresh-id(name)
    else: js-id-of(name)
    end|#
  end
  mod-ids = imports.map(lam(i): clean-import-name(i.name) end)
  module-locators = imports.map(lam(i):
    AU.import-to-dep(i.file)
  end)
  filenames = imports.map(lam(i):
      cases(A.ImportType) i.file:
        | s-const-import(_, name) => "trove/" + name
        | s-special-import(_, typ, args) =>
          if typ == "my-gdrive":
            "@my-gdrive/" + args.first
          else if typ == "shared-gdrive":
            "@shared-gdrive/" + args.first + "/" + args.rest.first
          else if typ == "js-http":
            "@js-http/" + args.first
          else if typ == "gdrive-js":
            "@gdrive-js/" + args.first + "/" + args.rest.first
          else:
            # NOTE(joe): under new module loading, this doesn't actually matter
            # NOTE(joe): yes it does, this is how we get a serialized rep of
            # the dependencies for the next time we need to check it
            CS.dependency(typ, args).key()
          end
      end
    end)
  # this needs to be freshened to support multiple repl interactions with the "same" source
  module-id = fresh-id(compiler-name(l.source)).tosourcestring()
  module-ref = lam(name): j-bracket(rt-field("modules"), j-str(name)) end
  input-ids = CL.map_list(lam(i):
      if A.is-s-atom(i) and (i.base == "$import"): js-names.make-atom("$$import")
      else: js-id-of(compiler-name(i.toname()))
      end
    end, mod-ids)
  cases-dispatches = dispatches-box(cl-empty)
  fun wrap-modules(modules, body-name, body-fun) block:
    mod-input-names = CL.map_list(_.input-id, modules)
    mod-input-ids = mod-input-names.map(j-id)
    mod-input-ids-list = mod-input-ids.to-list()
    mod-val-ids = modules.map(get-id)
    moduleVal = const-id("moduleVal")
    j-block(
      for CL.map_list(m from modules):
        j-var(m.id, j-id(m.input-id))
      end +
      cases-dispatches!dispatches +
      module-binds +
      [clist:
        j-var(body-name, body-fun),
        j-return(rt-method(
            "safeCall", [clist:
              j-id(body-name),
              j-fun(J.next-j-fun-id(),
                "module_load",
                [clist: moduleVal],
                j-block([clist:
                    j-expr(j-bracket-assign(rt-field("modules"), j-str(module-id), j-id(moduleVal))),
                    j-return(j-id(moduleVal))
                  ])),
              j-str("Evaluating " + body-name.toname())
        ]))])
  end
  module-specs = for map3(i from imports, id from mod-ids, in-id from input-ids.to-list()):
    { id: id, input-id: in-id, imp: i}
  end
  var locations = cl-empty
  var loc-count = 0
  var loc-cache = D.make-mutable-string-dict()
  LOCS = const-id("L")
  fun get-loc-id(shadow l :: Loc):
    as-str = l.key()
    if loc-cache.has-key-now(as-str) block:
      loc-cache.get-value-now(as-str)
    else:
      ans = loc-count
      loc-cache.set-now(as-str, ans)
      loc-count := loc-count + 1
      locations := cl-snoc(locations, obj-of-loc(l))
      ans
    end
  end
  fun get-loc(shadow l :: Loc):
    j-bracket(j-id(LOCS), j-num(get-loc-id(l)))
  end

  fun wrap-new-module(compiler, module-body):
    module-locators-as-js = for CL.map_list(m from module-locators):
      cases(CS.Dependency) m:
        | builtin(name) =>
          j-obj([clist:
            j-field("import-type", j-str("builtin")),
            j-field("name", j-str(name))])
        | dependency(protocol, args) =>
          j-obj([clist:
            j-field("import-type", j-str("dependency")),
            j-field("protocol", j-str(protocol)),
            j-field("args", j-list(true, CL.map_list(j-str, args)))])
      end
    end
    provides-obj = compile-provides(provides)
    the-module = j-fun(J.next-j-fun-id(), make-fun-name(compiler, l),
      [clist: RUNTIME.id, NAMESPACE.id, source-name.id] + input-ids, module-body)
    module-and-map = the-module.to-ugly-sourcemap(provides.from-uri, 1, 1, provides.from-uri)
    [D.string-dict:
      "requires", j-list(true, module-locators-as-js),
      "provides", provides-obj,
      "nativeRequires", j-list(true, [clist:]),
      "theModule",
        if compiler.options.collect-all: the-module
        else if compiler.options.module-eval == false: J.j-raw-code(module-and-map.code)
        else: J.j-str(module-and-map.code) end,
      "theMap", J.j-str(module-and-map.map)
      ]
  end

  step = fresh-id(compiler-name("step"))
  toplevel-name = fresh-id(compiler-name("toplevel"))
  apploc = fresh-id(compiler-name("al"))
  resumer = compiler-name("resumer")
  resumer-bind = N.a-bind(l, resumer, A.a-blank)
  body-compiler = self.{
    prog-provides: prog-provides,
    get-loc: get-loc,
    get-loc-id: get-loc-id,
    cur-apploc: apploc,
    resumer: resumer,
    allow-tco: false,
    dispatches: cases-dispatches
  }
  visited-body = compile-fun-body(l,
    body-compiler, # resumer gets js-id-of'ed in compile-fun-body
    [list: resumer-bind], none, prog, false)
  toplevel-fun = j-fun-async(J.next-j-fun-id(), make-fun-name(body-compiler, l), [clist: formal-shadow-name(resumer)], visited-body)
  define-locations = j-var(LOCS, j-list(true, locations))
  module-body = j-block(
    #                    [clist: j-expr(j-str("use strict"))] +
    mk-abbrevs(l) ^
    cl-snoc(_, define-locations) ^
    cl-append(_, global-binds) ^
    cl-snoc(_, wrap-modules(module-specs, toplevel-name, toplevel-fun)))
  wrap-new-module(body-compiler, module-body)
end

# Eventually maybe we should have a more general "optimization-env" instead of
# flatness-env. For now, leave it since our design might change anyway.
fun splitting-compiler(env, add-phase, { flatness-env; type-flatness-env}, provides, post-env, options):
  compiler-visitor.{
    uri: provides.from-uri,
    add-phase: add-phase,
    options: options,
    flatness-env: flatness-env,
    type-flatness-env: type-flatness-env,
    bindings: post-env.bindings,
    type-bindings: post-env.type-bindings,
    module-bindings: post-env.module-bindings,
    env: env,
    method a-program(self, l, prog-provides, imports, body) block:
      total-time := 0
      # This achieves nothing with our current code-gen, so it's a waste of time
      # simplified = body.visit(remove-useless-if-visitor)
      # add-phase("Remove useless ifs", simplified)
      freevars = N.freevars-prog(N.a-program(l, prog-provides, imports, body))
      add-phase("Freevars-e", freevars)
      ans = compile-module(self, l, prog-provides, imports, body, freevars, provides, env)
      add-phase(string-append("Total simplification: ", tostring(total-time)), nothing)
      ans
    end
  }
end
