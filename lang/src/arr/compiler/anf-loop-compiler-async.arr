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
  # Iterate in sorted key order so emitted field order is deterministic
  # (string-dict iteration order is unspecified)
  for fold(acc from cl-empty, key from sd.keys-list().sort()):
    cl-snoc(acc, f(key))
  end
end

fun make-fun-name(compiler, loc) -> String:
  "_" + sha.sha256(compiler.uri) + "__" + num-to-string(compiler.get-loc-id(loc))
end

fun type-name(str :: String) -> String:
  string-append("$type$", str)
end

j-fun = J.j-fun
j-async-fun = J.j-async-fun
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



fun compile-anns(visitor, step, binds :: List<N.ABind>, entry-label):
  var cur-target = entry-label
  new-cases = for lists.fold(acc from cl-empty, b from binds):
    if A.is-a-blank(b.ann) or A.is-a-any(b.ann) block:
      acc
    else if A.is-a-tuple(b.ann) and b.ann.fields.all(lam(a): A.is-a-blank(a) or A.is-a-any(a) end):
      new-label = visitor.make-label()
      new-case =
        j-case(cur-target,
          j-block(
            [clist:
              j-expr(j-assign(step, new-label)),
              j-expr(j-assign(visitor.cur-apploc, visitor.get-loc(b.ann.l))),
              j-expr(rt-method("checkTupleBind", [clist: j-id(js-id-of(b.id)), j-num(b.ann.fields.length()),
                    visitor.get-loc(b.ann.l)])),
              j-break
            ]))
      cur-target := new-label
      cl-snoc(acc, new-case)
    else if is-flat-enough(FL.ann-flatness(b.ann, visitor.flatness-env, visitor.type-flatness-env, visitor.module-bindings, visitor.env)):
      compiled-ann = compile-ann(b.ann, none, visitor)
      new-label = visitor.make-label()
      new-case = j-case(cur-target,
        j-block(cl-append(compiled-ann.other-stmts,
            [clist:
              j-expr(j-assign(step, new-label)),
              j-expr(j-assign(visitor.cur-apploc, visitor.get-loc(b.ann.l))),
              j-expr(rt-method("_checkAnn",
                  [clist: visitor.get-loc(b.ann.l), compiled-ann.exp, j-id(js-id-of(b.id))])),
              j-break])))
      cur-target := new-label
      cl-snoc(acc, new-case)
    else:
      ann-result = fresh-id(compiler-name("ann-check"))
      compiled-ann = compile-ann(b.ann, none, visitor)
      new-label = visitor.make-label()
      new-case = j-case(cur-target,
        j-block(cl-append(compiled-ann.other-stmts,
            [clist:
              j-expr(j-assign(step, new-label)),
              j-expr(j-assign(visitor.cur-apploc, visitor.get-loc(b.ann.l))),
              j-var(ann-result, rt-method("_checkAnn",
                  [clist: visitor.get-loc(b.ann.l), compiled-ann.exp, j-id(js-id-of(b.id))])),
              j-if1(rt-method("isContinuation", [clist: j-id(ann-result)]),
                j-block([clist:
                    j-expr(j-assign(visitor.cur-ans, j-id(ann-result)))])),
              j-break])))
      cur-target := new-label
      cl-snoc(acc, new-case)
    end
  end
  { new-cases: new-cases, new-label: cur-target }
end

fun compile-annotated-let(visitor, b :: BindType, compiled-e :: DAG.CaseResults%(is-c-exp), compiled-body :: DAG.CaseResults%(is-c-block)) -> DAG.CaseResults%(is-c-block):
  id-assign = if is-b-let(b):
      cl-sing(j-var(js-id-of(b.value.id), compiled-e.exp))
    else if is-b-array(b):
      cl-sing(j-expr(j-bracket-assign(j-id(js-id-of(b.value.id)), j-num(b.idx), compiled-e.exp)))
    else:
      raise(string-append(string-append("Unknown ", b.value.label()), " in compile-annotated-let"))
    end
  shadow b = b.value
  if A.is-a-blank(b.ann) or A.is-a-any(b.ann):
    c-block(
      j-block(
        cl-append(
          cl-append(
            compiled-e.other-stmts,
            id-assign),
          compiled-body.block.stmts)
        ),
      compiled-body.new-cases
      )
  else if A.is-a-tuple(b.ann) and b.ann.fields.all(lam(a): A.is-a-blank(a) or A.is-a-any(a) end):
    step = visitor.cur-step
    after-ann = visitor.make-label()
    after-ann-case = j-case(after-ann, j-block(compiled-body.block.stmts))
    c-block(
      j-block(
        cl-append(compiled-e.other-stmts,
          cl-append(id-assign,
            [clist:
              j-expr(j-assign(step, after-ann)),
              j-expr(j-assign(visitor.cur-apploc, visitor.get-loc(b.ann.l))),
              j-expr(rt-method("checkTupleBind", [clist: j-id(js-id-of(b.id)), j-num(b.ann.fields.length()),
                    visitor.get-loc(b.ann.l)])),
              j-break
            ]))),
      cl-cons(after-ann-case, compiled-body.new-cases))
  else:
    step = visitor.cur-step
    after-ann = visitor.make-label()
    after-ann-case = j-case(after-ann, j-block(compiled-body.block.stmts))
    compiled-ann = compile-ann(b.ann, none, visitor)
    ann-result = fresh-id(compiler-name("ann-check"))
    c-block(
      j-block(
        compiled-e.other-stmts ^
        cl-append(_, id-assign) ^
        cl-append(_, compiled-ann.other-stmts) ^
        cl-append(_, [clist:
            j-expr(j-assign(step, after-ann)),
            j-expr(j-assign(visitor.cur-apploc, visitor.get-loc(b.ann.l))),
            j-var(ann-result, rt-method("_checkAnn",
                [clist: visitor.get-loc(b.ann.l), compiled-ann.exp, j-id(js-id-of(b.id))])),
            j-if1(rt-method("isContinuation", [clist: j-id(ann-result)]),
              j-block([clist:
                  j-expr(j-assign(visitor.cur-ans, j-id(ann-result)))])),
            j-break
          ])),
        cl-cons(after-ann-case, compiled-body.new-cases))
  end
end

fun get-remaining-code(compiler, opt-dest, body, ans) -> {J.JBlock;CList<J.JCase>}:
  compiled-body = body.visit(compiler)
  shadow compiled-body = cases(Option) opt-dest:
    | some(dest) =>
      compiled-binding = compile-annotated-let(compiler, dest, c-exp(j-id(ans), cl-empty), compiled-body)
      compiled-binding
    | none =>
      compiled-body
  end

  {compiled-body.block; compiled-body.new-cases}
end

# Return code for opt-body and the label the caller should jump to after
# their block of code is done
fun get-new-cases(compiler, opt-dest, opt-body, ans) -> {CList<J.JBlock>; J.JExpr}:
  cases(Option) opt-body:
    | some(compiled-body) =>
      pre-body-label = compiler.make-label()
      {next-block; next-cases} = get-remaining-code(compiler, opt-dest, compiled-body, ans)
      remaining-cases = cl-cons(j-case(pre-body-label, next-block), next-cases)

      {remaining-cases; pre-body-label}
    | none => {cl-empty; compiler.cur-target}
  end
end

fun compile-split-method-app(l, compiler, opt-dest, obj, methname, args, opt-body):
  ans = compiler.cur-ans
  step = compiler.cur-step
  compiled-obj = obj.visit(compiler).exp
  compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
  # num-args = args.length()

  argcount = compiled-args.length()

  helper-name = if argcount <= 7:
    "maybeMethodCall" + to-string(argcount)
  else:
    "maybeMethodCall"
  end

  if J.is-j-id(compiled-obj):
    call = wrap-with-srcnode(l,
      rt-method(helper-name,
        cl-append([clist: compiled-obj,
            j-str(methname),
            compiler.get-loc(l)],
          compiled-args)))
    {new-cases; after-app-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
    c-block(j-block([clist:
      j-expr(j-assign(step, after-app-label)),
      j-expr(j-assign(ans, call)),
      j-break
    ]), new-cases)
  else:
    obj-id = j-id(fresh-id(compiler-name("obj")))
    colon-field = rt-method("getColonFieldLoc", [clist: obj-id, j-str(methname), compiler.get-loc(l)])
    colon-field-id = j-id(fresh-id(compiler-name("field")))
    check-method = rt-method("isMethod", [clist: colon-field-id])
    {new-cases; after-app-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
    c-block(
      j-block([clist:
          # Update step before the call, so that if it runs out of gas, the resumer goes to the right step
          j-expr(j-assign(step,  after-app-label)),
          j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l))),
          j-var(obj-id.id, compiled-obj),
          j-var(colon-field-id.id, colon-field),
          # if num-args < 6:
          #   j-expr(j-assign(ans, rt-method("callIfPossible" + tostring(num-args),
          #         link(compiler.get-loc(l), link(colon-field-id, link(obj-id, compiled-args))))))
          # else:
            j-if(check-method, j-block([clist:
                  j-expr(j-assign(ans, j-app(j-dot(colon-field-id, "full_meth"),
                        cl-cons(obj-id, compiled-args))))
                ]),
              j-block([clist:
                  check-fun(l, compiler.get-loc(l), colon-field-id),
                  j-expr(wrap-with-srcnode(l, j-assign(ans, app(l, colon-field-id, compiled-args))))
                ])),
            # If the answer is a cont, jump to the end of the current function
            # rather than continuing normally
          j-break]),
      new-cases)
  end
end

fun is-id-occurs(target :: A.Name, e :: J.JExpr) block:
  doc: "Returns true iff `target` occurs in `e`"
  dummy-js-expr = j-num(0)
  var found = false
  e.visit(J.default-map-visitor.{
    method j-id(self, name) block:
      when name == target:
        found := true
      end
      dummy-js-expr
    end
  })
  found
end

fun get-assignments(lst :: List<J.JExpr>, limit :: Number) -> {List<J.JStmt>; List<J.JStmt>}:
  doc: ```
       Find an order of assignment statements in `lst` that avoid new variables
       where `limit` is the number of round-robin attempts allowed.

       When the dependency graph is acyclic, this algorithm degenerates to
       finding a topological order.

       If the RHS of assignment statements have at most one identifier,
       it's possible that the corresponding dependency graph will have cycles,
       but there can be at most one cycle per connected component. Thus, this
       algorithm degenerates to finding topological order at most twice per
       component (one for ordering non-cycle parts, then we break the cycle
       and then another one for the ordering the rest). It guarantees that
       it will reach limit = 0 at most once per each component.

       The output is a pair of `pre` and `post` which are lists of
       assignments. The order of `post` doesn't matter.
       ```
  cases (List) lst:
    | empty => {empty; empty}
    | link(asgn, rest) =>
      cases (J.JExpr) asgn:
        | j-assign(formal, actual) =>
          if limit == 0:
            tmp-arg = fresh-id(compiler-name('tmp_asgn'))
            {pre; post} = get-assignments(rest, rest.length())
            {link(j-var(tmp-arg, actual), pre); link(j-expr(j-assign(formal, j-id(tmp-arg))), post)}
          else:
            occurs-any = for any(next-asgn :: J.JExpr%(is-j-assign) from rest):
              is-id-occurs(formal, next-asgn.rhs)
            end
            if occurs-any:
              get-assignments(rest + [list: asgn], limit - 1)
            else:
              {pre; post} = get-assignments(rest, rest.length())
              {link(j-expr(asgn), pre); post}
            end
          end
      end
  end
end

fun compile-split-app(l, compiler, opt-dest, f, args, opt-body, app-info, is-definitely-fn):
  ans = compiler.cur-ans
  step = compiler.cur-step
  compiled-f = f.visit(compiler).exp
  compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
  {new-cases; after-app-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
  if app-info.is-recursive and
     app-info.is-tail and
     compiler.allow-tco and
     compiler.options.proper-tail-calls and
     (compiled-args.length() == compiler.args.length()):
     # if it's an arity mismatch, use non-TCO to handle the error
    args-list = map2(j-assign, compiler.args, compiled-args.to-list())
    {pre; post} = get-assignments(args-list, args-list.length())
    c-block(
      j-block(
        [clist:
          # Update step before the call, so that if it runs out of gas,
          # the resumer goes to the right step
          j-expr(j-assign(step, j-num(0))),
          j-expr(j-unop(j-id(compiler.elided-frames), j-incr)),
          j-if1(j-binop(j-unop(rt-field("RUNGAS"), j-decr), J.j-leq, j-num(0)),
            j-block([clist:
              j-expr(j-dot-assign(RUNTIME, "EXN_STACKHEIGHT", j-num(0))),
              j-expr(j-assign(ans, rt-method("makeCont", cl-empty)))]))] +
        CL.from_list(pre + post) +
        # CL.map_list2(
        #   lam(compiled-arg, arg):
        #     console-log-stmt([clist: j-str(tostring(arg)), j-id(arg)])
        #   end,
        #   compiled-args.to-list(),
        #   compiler.args) +
        cl-sing(j-continue)),
      new-cases)
  else:
    c-block(
      j-block(
        # Update step before the call, so that if it runs out of gas,
        # the resumer goes to the right step
        [clist:
          j-expr(j-assign(step, after-app-label)),
          j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l)))] +
        if not(is-definitely-fn):
          cl-sing(check-fun(l, j-id(compiler.cur-apploc), compiled-f))
        else:
          cl-sing(j-expr(j-raw-code("// omitting isFunction check")))
        end +
        [clist:
          j-expr(wrap-with-srcnode(l, j-assign(ans, app(l, compiled-f, compiled-args)))),
          j-break]),
      new-cases)
  end
end

fun j-block-to-stmt-list(b :: J.JBlock) -> CL.ConcatList<J.JStmt>:
  cases (J.JBlock) b:
    | j-block(stmt-list) => stmt-list
    | j-block1(stmt) => cl-sing(stmt)
  end
end

fun compile-flat-app(l, compiler, opt-dest, f, args, opt-body, app-info, is-definitely-fn) block:
  ans = compiler.cur-ans
  compiled-f = f.visit(compiler).exp
  compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)

  # Generate the code for calling the function
  call-code = [clist:
    j-expr(j-raw-code("// caller optimization")),
    j-expr(wrap-with-srcnode(l, j-assign(ans, app(l, compiled-f, compiled-args))))
  ]

  # Compile the body of the let. We split it into two portions:
  # 1) the code that can be in the same "block" (or case region) and
  # 2) the rest of the case statements
  {remaining-code; new-cases} = cases (Option) opt-body:
    | some(body) =>
      get-remaining-code(compiler, opt-dest, body, ans)
    | none =>
      # Special case: there is no more code after this so just jump to the
      # special last block in the function
      body = j-block([clist:
          j-expr(j-assign(compiler.cur-step, compiler.cur-target)),
          j-break
        ])
      {body; cl-empty}
  end

  # Now merge the code for calling the function with the next block
  # (this is basically our optimization, since we're not starting a new case
  # for the next block)
  c-block(
    j-block(cl-append(call-code, j-block-to-stmt-list(remaining-code))),
    new-cases)
end

fun compile-split-if(compiler, opt-dest, cond, consq, alt, opt-body):
  consq-label = compiler.make-label()
  alt-label = compiler.make-label()
  ans = compiler.cur-ans
  {after-if-cases; after-if-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
  compiler-after-if = compiler.{cur-target: after-if-label}
  compiled-consq = consq.visit(compiler-after-if)
  compiled-alt = alt.visit(compiler-after-if)

  new-cases =
    cl-append(
      cl-append(
        cl-cons(j-case(consq-label, compiled-consq.block), compiled-consq.new-cases),
        cl-cons(j-case(alt-label, compiled-alt.block), compiled-alt.new-cases)),
      after-if-cases)
  c-block(
    j-block([clist:
        j-expr(j-assign(compiler.cur-step,
            j-ternary(rt-method("checkPyretTrue", [clist: cond.visit(compiler).exp]),
              consq-label, alt-label))),
        j-break
      ]),
    new-cases)
end
fun compile-cases-branch(compiler, compiled-val, branch :: N.ACasesBranch, cases-loc):
  compiled-body = branch.body.visit(compiler)
  if compiled-body.new-cases.length() < compiler.options.inline-case-body-limit:
    compile-inline-cases-branch(compiler, compiled-val, branch, compiled-body, cases-loc)
  else:
    temp-branch = fresh-id(compiler-name("temp_branch"))
    branch-args =
      if N.is-a-cases-branch(branch) and is-link(branch.args): branch.args.map(get-bind)
      else: [list: N.a-bind(branch.body.l, compiler.resumer, A.a-blank)]
      end
    step = fresh-id(compiler-name("step"))
    ref-binds-mask = if N.is-a-cases-branch(branch):
      j-list(false, for CL.map_list(cb from branch.args):
          j-bool(A.is-s-cases-bind-ref(cb.field-type))
        end)
    else:
      j-list(false, cl-empty)
    end
    compiled-branch-fun =
      compile-fun-body(branch.body.l, step, temp-branch, compiler.{allow-tco: false, options: compiler.options.{should-profile: false}}, branch-args, none, branch.body, true, false, false, false)
    preamble = cases-preamble(compiler, compiled-val, branch, cases-loc)
    deref-fields = j-expr(j-assign(compiler.cur-ans, j-method(compiled-val, "$app_fields", [clist: j-id(temp-branch), ref-binds-mask])))
    actual-app =
      [clist:
        j-expr(j-assign(compiler.cur-step, compiler.cur-target)),
        j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(branch.l))),
        j-var(temp-branch,
          j-fun(J.next-j-fun-id(), make-fun-name(compiler, cases-loc),
            CL.map_list(lam(arg): formal-shadow-name(arg.id) end, branch-args), compiled-branch-fun)),
        deref-fields,
        j-break]

    c-block(
      j-block(cl-append(preamble, actual-app)),
      cl-empty)
  end
end
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
fun compile-inline-cases-branch(compiler, compiled-val, branch, compiled-body, cases-loc):
  preamble = cases-preamble(compiler, compiled-val, branch, cases-loc)
  if N.is-a-cases-branch(branch):
    entry-label = compiler.make-label()
    ann-cases = compile-anns(compiler, compiler.cur-step, branch.args.map(get-bind), entry-label)
    field-names = j-id(js-id-of(fresh-id(compiler-name("fn"))))
    get-field-names = j-var(field-names.id, j-dot(j-dot(compiled-val, "$constructor"), "$fieldNames"))
    deref-fields =
      for CL.map_list_n(i from 0, arg from branch.args):
        mask = j-bracket(j-dot(compiled-val, "$mut_fields_mask"), j-num(i))
        field = get-dict-field(compiled-val, j-bracket(field-names, j-num(i)))
        j-var(js-id-of(arg.bind.id),
          rt-method("derefField", [clist: field, mask, j-bool(A.is-s-cases-bind-ref(arg.field-type))]))
      end
    if ann-cases.new-cases == cl-empty:
      c-block(j-block(preamble
            ^ cl-snoc(_, get-field-names)
            ^ cl-append(_, deref-fields)
            ^ cl-append(_, compiled-body.block.stmts)),
        compiled-body.new-cases)
    else:
      c-block(j-block(
          preamble
            ^ cl-snoc(_, get-field-names)
            ^ cl-append(_, deref-fields)
            ^ cl-snoc(_, j-expr(j-assign(compiler.cur-step, entry-label)))
            ^ cl-snoc(_, j-break)),
        ann-cases.new-cases
          ^ cl-append(_, compiled-body.new-cases)
          ^ cl-snoc(_, j-case(ann-cases.new-label, compiled-body.block)))
    end
  else:
    c-block(j-block(cl-append(preamble, compiled-body.block.stmts)), compiled-body.new-cases)
  end
end
fun compile-split-cases(compiler, cases-loc, opt-dest, typ, val :: N.AVal, branches :: List<N.ACasesBranch>, _else :: N.AExpr, opt-body :: Option<N.AExpr>) block:
  compiled-val = val.visit(compiler).exp
  {after-cases-cases; after-cases-label} = get-new-cases(compiler, opt-dest, opt-body, compiler.cur-ans)
  compiler-after-cases = compiler.{cur-target: after-cases-label}
  compiled-branches = branches.map(compile-cases-branch(compiler-after-cases, compiled-val, _, cases-loc))
  compiled-else = _else.visit(compiler-after-cases)
  branch-labels = branches.map(lam(_): compiler.make-label() end)
  else-label = compiler.make-label()
  branch-cases = for fold2(acc from cl-empty, label from branch-labels, branch from compiled-branches):
    acc
    ^ cl-snoc(_, j-case(label, branch.block))
    ^ cl-append(_, branch.new-cases)
  end
  branch-else-cases =
    (branch-cases
      ^ cl-snoc(_, j-case(else-label, compiled-else.block))
      ^ cl-append(_, compiled-else.new-cases))
  dispatch-table = j-obj(for CL.map_list2(branch from branches, label from branch-labels): j-field(branch.name, label) end)
  dispatch = j-id(fresh-id(compiler-name("cases_dispatch")))
  compiler.dispatches!{
    dispatches: cl-cons(j-var(dispatch.id, dispatch-table), compiler.dispatches!dispatches)
  }
  # NOTE: Ignoring typ for the moment!
  new-cases = cl-append(branch-else-cases, after-cases-cases)
  c-block(
    j-block([clist:
        # j-expr(j-app(j-dot(j-id("console"), "log"),
        #     [list: j-str("$name is "), j-dot(compiled-val, "$name"),
        #       j-str("val is "), compiled-val,
        #       j-str("dispatch is "), dispatch])),
        j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(cases-loc))),
        j-expr(j-assign(compiler.cur-step,
            j-binop(j-bracket(dispatch, j-dot(compiled-val, "$name")), J.j-or, else-label))),
        j-break]),
    new-cases)
end

fun compile-split-update(compiler, loc, opt-dest, obj :: N.AVal, fields :: List<N.AField>, opt-body :: Option<N.AExpr>):
  ans = compiler.cur-ans
  step = compiler.cur-step
  compiled-obj = obj.visit(compiler).exp
  compiled-field-vals = CL.map_list(lam(a): a.value.visit(compiler).exp end, fields)
  field-names = CL.map_list(lam(f): j-str(f.name) end, fields)
  field-locs = CL.map_list(lam(f): compiler.get-loc(f.l) end, fields)
  {new-cases; after-update-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
  c-block(
    j-block([clist:
        # Update step before the call, so that if it runs out of gas, the resumer goes to the right step
        j-expr(j-assign(step, after-update-label)),
        j-expr(j-assign(ans, rt-method("checkRefAnns",
          [clist:
            compiled-obj,
            j-list(false, field-names),
            j-list(false, compiled-field-vals),
            j-list(false, field-locs),
            compiler.get-loc(loc),
            compiler.get-loc(obj.l)]))),
        j-break]),
    new-cases)

end

fun is-id-fn-name(flatness-env :: D.MutableStringDict<Option<Number>>, name :: String) -> Boolean:
    flatness-env.has-key-now(name)
end

# --- Async/promise backend codegen (Stage 3) ----------------------------------
# A "completion" turns the final JExpr of a tail expression into statements.
# It lives on the compiler as `complete`; `tail-pos` records whether we are in
# real function-tail position (so TCO `continue` is only emitted when valid).
# NOTE: defined with `fun` (not `x = lam`) so it doesn't split the top-level
# letrec group and break forward references to compile-fun-body.
fun complete-return(v :: J.JExpr) -> CL.ConcatList<J.JStmt>:
  cl-sing(j-return(v))
end

fun compile-aexpr-async(compiler, e :: N.AExpr) -> CL.ConcatList<J.JStmt>:
  # Every AExpr visitor method returns a c-block whose new-cases are empty;
  # the straight-line statements live in `.block.stmts`.
  e.visit(compiler).block.stmts
end

fun ann-check-stmts(compiler, b :: N.ABind) -> CL.ConcatList<J.JStmt>:
  # Re-bind `b` to the result of checking its annotation. A non-flat annotation
  # may run a user refinement (async, returns a Promise), so we await it; a flat
  # annotation's _checkAnn is synchronous. This gate must agree with the flatness
  # analysis (which folds ann-flatness into the enclosing function's flatness),
  # or we get `await` in a sync function (JS syntax error) or an unawaited Promise.
  if A.is-a-blank(b.ann) or A.is-a-any(b.ann):
    cl-empty
  else if A.is-a-tuple(b.ann) and b.ann.fields.all(lam(a): A.is-a-blank(a) or A.is-a-any(a) end):
    # A tuple-destructuring bind with no field annotations: just check the tuple
    # shape/length (checkTupleBind raises "bad-tuple-bind"). This mirrors the cont
    # backend; the general tuple-ann _checkAnn gives a different ("annotation")
    # error that a few tests pin on.
    cl-sing(j-expr(rt-method("checkTupleBind",
          [clist: j-id(js-id-of(b.id)), j-num(b.ann.fields.length()), compiler.get-loc(b.ann.l)])))
  else:
    ca = compile-ann(b.ann, none, compiler)
    is-flat = is-flat-enough(FL.ann-flatness(b.ann, compiler.flatness-env,
        compiler.type-flatness-env, compiler.module-bindings, compiler.env))
    check-call = rt-method("_checkAnn",
      [clist: compiler.get-loc(ann-loc(b.ann)), ca.exp, j-id(js-id-of(b.id))])
    checked = if is-flat: check-call else: j-await(check-call) end
    cl-snoc(ca.other-stmts, j-expr(j-assign(js-id-of(b.id), checked)))
  end
end

fun args-other-stmts(arg-ces :: List) -> CL.ConcatList<J.JStmt>:
  for fold(acc from cl-empty, ac from arg-ces):
    cl-append(acc, ac.other-stmts)
  end
end

fun compile-app-async(compiler, l, f :: N.AVal, args :: List<N.AVal>, app-info :: A.AppInfo) -> CL.ConcatList<J.JStmt>:
  is-safe-id = N.is-a-id(f) or N.is-a-id-safe-letrec(f)
  # is-flat must agree with the flatness analysis (flatness.arr), which decides
  # whether the enclosing function is emitted sync (j-fun) or async (j-async-fun).
  # If they disagree we either emit `await` inside a sync function (a JS syntax
  # error) or fail to await a Promise. For module-ref calls, the analysis uses
  # get-flatness-for-module-call, so we mirror it here.
  is-flat =
    if is-safe-id: is-function-flat(compiler.flatness-env, f.id.key())
    else if N.is-a-id-modref(f):
      is-flat-enough(FL.get-flatness-for-module-call(f.id, f.name, compiler.module-bindings, compiler.env))
    else: false
    end
  is-fn = is-safe-id and is-id-fn-name(compiler.flatness-env, f.id.key())
  f-ce = f.visit(compiler)
  arg-ces = args.map(_.visit(compiler))
  compiled-args = CL.map_list(get-exp, arg-ces)
  pre = cl-append(f-ce.other-stmts, args-other-stmts(arg-ces))
  # TCO-ness is decided by the ANF's `app-info.is-tail` (the authoritative tail
  # analysis the cont backend also trusts), NOT by the syntactic `compiler.tail-pos`
  # flag. They diverge for the return-annotation pattern: `fun f(...) -> T:` desugars
  # the tail self-call into `let ans = f(...) in _checkAnn(T, ans)`, so the call is
  # let-bound (tail-pos = false) yet still app-info.is-tail = true. Gating on tail-pos
  # there wrongly defeated TCO -> the self-call awaited+accumulated an async frame per
  # level, so a deep annotated tail loop went O(n) heap (slow, and OOM at ~20M deep).
  # `continue` skips the per-iteration _checkAnn, which is sound: the returned value is
  # the base case's already-checked value (cont's trampoline skips it identically).
  # in-tco-loop ensures the `while(true)` continue-target exists.
  is-tco = compiler.in-tco-loop and
    app-info.is-recursive and app-info.is-tail and
    compiler.allow-tco and compiler.options.proper-tail-calls and
    (compiled-args.length() == compiler.args.length())
  if is-tco:
    # Explicit-loop tail-call optimization: rebind formals and loop.
    args-list = map2(j-assign, compiler.args, compiled-args.to-list())
    {asgn-pre; asgn-post} = get-assignments(args-list, args-list.length())
    cl-append(pre, cl-snoc(CL.from_list(asgn-pre + asgn-post), j-continue))
  else:
    fn-check = if is-fn: cl-empty else: cl-sing(check-fun(l, compiler.get-loc(l), f-ce.exp)) end
    # Safe-for-space tail call: in genuine tail position (complete-return), inside a
    # token-producing async body, calling a non-flat callee, mint a bounce token
    # instead of `return await f.app(...)`. The nearest driver (the public `.app`
    # wrapper, installed by makeTailFunction) pumps it — O(1) heap for mutual /
    # higher-order / cross-module tail recursion. A flat callee can't recurse deeply
    # (bounded), so we keep its cheap direct return and don't force a driver. The
    # token references the callee VALUE (f-ce.exp), whose `appBody` the driver calls.
    mint-token = compiler.mints-tokens and compiler.tail-pos and not(is-flat)
    if mint-token block:
      compiler.token-cell.set-now("minted", true)
      token = rt-method("tailCall", [clist: f-ce.exp, j-list(false, compiled-args)])
      cl-append(pre, cl-append(fn-check, cl-sing(j-return(token))))
    else:
      call-base = app(l, f-ce.exp, compiled-args)
      value = if is-flat: call-base else: j-await(call-base) end
      cl-append(pre, cl-append(fn-check, compiler.complete(value)))
    end
  end
end

fun compile-method-app-async(compiler, l, obj :: N.AVal, methname :: String, args :: List<N.AVal>) -> CL.ConcatList<J.JStmt>:
  obj-ce = obj.visit(compiler)
  arg-ces = args.map(_.visit(compiler))
  compiled-args = CL.map_list(get-exp, arg-ces)
  pre = cl-append(obj-ce.other-stmts, args-other-stmts(arg-ces))
  argcount = compiled-args.length()
  helper-name = if argcount <= 7: "maybeMethodCall" + tostring(argcount) else: "maybeMethodCall" end
  compiled-obj = obj-ce.exp
  if compiler.mints-tokens and compiler.tail-pos block:
    # Safe-for-space tail call THROUGH a method: mint a token instead of driving.
    # maybeMethodTail resolves obj.methname (obj evaluated once, as a single arg)
    # and returns a TailMethodCall (method field) or TailCall (function field);
    # the nearest driver pumps it. Same gate as compile-app-async, and it records
    # the mint so the enclosing closure/method gets a driving wrapper.
    compiler.token-cell.set-now("minted", true)
    token = wrap-with-srcnode(l,
      rt-method("maybeMethodTail",
        cl-append([clist: compiled-obj, j-str(methname), compiler.get-loc(l)], compiled-args)))
    cl-append(pre, cl-sing(j-return(token)))
  else if J.is-j-id(compiled-obj):
    call = wrap-with-srcnode(l,
      rt-method(helper-name,
        cl-append([clist: compiled-obj, j-str(methname), compiler.get-loc(l)], compiled-args)))
    cl-append(pre, compiler.complete(j-await(call)))
  else:
    obj-id = fresh-id(compiler-name("obj"))
    field-id = fresh-id(compiler-name("field"))
    ans-id = fresh-id(compiler-name("mans"))
    colon-field = rt-method("getColonFieldLoc", [clist: j-id(obj-id), j-str(methname), compiler.get-loc(l)])
    check-method = rt-method("isMethod", [clist: j-id(field-id)])
    branch = j-if(check-method,
      j-block1(j-expr(j-assign(ans-id,
            j-await(j-app(j-dot(j-id(field-id), "full_meth"), cl-cons(j-id(obj-id), compiled-args)))))),
      j-block([clist:
          check-fun(l, compiler.get-loc(l), j-id(field-id)),
          j-expr(j-assign(ans-id, j-await(wrap-with-srcnode(l, app(l, j-id(field-id), compiled-args)))))]))
    decls = [clist: j-var(obj-id, compiled-obj), j-var(field-id, colon-field), j-var(ans-id, undefined)]
    cl-append(pre, cl-append(decls, cl-cons(branch, compiler.complete(j-id(ans-id)))))
  end
end

fun compile-update-async(compiler, l, obj :: N.AVal, fields :: List<N.AField>) -> CL.ConcatList<J.JStmt>:
  obj-ce = obj.visit(compiler)
  field-ces = fields.map(lam(fld): fld.value.visit(compiler) end)
  pre = cl-append(obj-ce.other-stmts, args-other-stmts(field-ces))
  field-names = CL.map_list(lam(fld): j-str(fld.name) end, fields)
  field-locs = CL.map_list(lam(fld): compiler.get-loc(fld.l) end, fields)
  field-vals = CL.map_list(get-exp, field-ces)
  call = rt-method("checkRefAnns",
    [clist:
      obj-ce.exp,
      j-list(false, field-names),
      j-list(false, field-vals),
      j-list(false, field-locs),
      compiler.get-loc(l),
      compiler.get-loc(obj.l)])
  cl-append(pre, compiler.complete(j-await(call)))
end

fun compile-cases-branch-async(compiler, val-id, branch :: N.ACasesBranch, cases-loc) -> CL.ConcatList<J.JStmt>:
  preamble = cases-preamble(compiler, j-id(val-id), branch, cases-loc)
  body-stmts =
    if N.is-a-cases-branch(branch):
      field-names = fresh-id(compiler-name("fn"))
      get-field-names = j-var(field-names, j-dot(j-dot(j-id(val-id), "$constructor"), "$fieldNames"))
      deref-fields =
        for CL.map_list_n(i from 0, arg from branch.args):
          mask = j-bracket(j-dot(j-id(val-id), "$mut_fields_mask"), j-num(i))
          field = get-dict-field(j-id(val-id), j-bracket(j-id(field-names), j-num(i)))
          j-var(js-id-of(arg.bind.id),
            rt-method("derefField", [clist: field, mask, j-bool(A.is-s-cases-bind-ref(arg.field-type))]))
        end
      ann-stmts = for fold(acc from cl-empty, arg from branch.args):
        cl-append(acc, ann-check-stmts(compiler, arg.bind))
      end
      cl-append(cl-cons(get-field-names, deref-fields),
        cl-append(ann-stmts, compile-aexpr-async(compiler, branch.body)))
    else:
      compile-aexpr-async(compiler, branch.body)
    end
  cl-append(preamble, body-stmts)
end

fun compile-cases-async(compiler, cases-loc, typ, val :: N.AVal, branches :: List<N.ACasesBranch>, _else :: N.AExpr) -> CL.ConcatList<J.JStmt>:
  val-ce = val.visit(compiler)
  val-id = fresh-id(compiler-name("cases_val"))
  branch-cases = for CL.map_list(branch from branches):
    j-case(j-str(branch.name),
      j-block(cl-snoc(compile-cases-branch-async(compiler, val-id, branch, cases-loc), j-break)))
  end
  else-case = j-default(j-block(cl-snoc(compile-aexpr-async(compiler, _else), j-break)))
  the-switch = j-switch(j-dot(j-id(val-id), "$name"), cl-snoc(branch-cases, else-case))
  cl-append(val-ce.other-stmts,
    [clist:
      j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(cases-loc))),
      j-var(val-id, val-ce.exp),
      the-switch])
end

fun compile-lettable-async(compiler, e :: N.ALettable) -> CL.ConcatList<J.JStmt>:
  # Compile a lettable in tail-with-completion style: the final value flows to
  # `compiler.complete`. Control-flow lettables push the completion into their
  # sub-expressions so no join point / trampoline case is needed.
  cases(N.ALettable) e:
    | a-app(l, f, args, app-info) =>
      compile-app-async(compiler, l, f, args, app-info)
    | a-method-app(l, obj, m, args) =>
      compile-method-app-async(compiler, l, obj, m, args)
    | a-prim-app(l, f, args, app-info) =>
      arg-ces = args.map(_.visit(compiler))
      call = wrap-with-srcnode(l, rt-method(f, CL.map_list(get-exp, arg-ces)))
      value = if app-info.needs-step: j-await(call) else: call end
      cl-append(args-other-stmts(arg-ces), compiler.complete(value))
    | a-if(l, cond, consq, alt) =>
      cond-ce = cond.visit(compiler)
      test = rt-method("checkPyretTrue", [clist: cond-ce.exp])
      the-if = j-if(test,
        j-block(compile-aexpr-async(compiler, consq)),
        j-block(compile-aexpr-async(compiler, alt)))
      cl-snoc(cond-ce.other-stmts, the-if)
    | a-cases(l, typ, val, branches, _else) =>
      compile-cases-async(compiler, l, typ, val, branches, _else)
    | a-update(l, obj, fields) =>
      compile-update-async(compiler, l, obj, fields)
    | a-lam(l, name, args, ret, body) =>
      # Lambdas are lifted to let-RHS by ANF; use the enclosing binding (if any)
      # for the flatness lookup that decides sync vs async emission.
      ce = compile-a-lam(compiler, l, name, args, ret, body, compiler.cur-let-bind)
      cl-append(ce.other-stmts, compiler.complete(ce.exp))
    | else =>
      ce = e.visit(compiler)
      cl-append(ce.other-stmts, compiler.complete(ce.exp))
  end
end

fun compile-fun-body(l :: Loc, step :: A.Name, fun-name :: A.Name, compiler, args :: List<N.ABind>, opt-arity :: Option<Number>, body :: N.AExpr, should-report-error-frame :: Boolean, is-flat :: Boolean, is-method :: Boolean, can-mint-tokens :: Boolean) -> J.JBlock block:
  # Detect whether a formal argument is captured by an inner lambda; if so we
  # cannot do explicit-loop TCO (the loop would clobber the captured binding).
  var in-lam = false
  var arg-used-in-lambda = false
  arg-names = args.map(_.id)
  dummy-anf-lettable = N.a-obj(A.dummy-loc, empty)
  body.visit(N.default-map-visitor.{
    method a-lam(self, _, _, _, _, shadow body) block:
      saved-in-lam = in-lam
      in-lam := true
      body.visit(self)
      in-lam := saved-in-lam
      dummy-anf-lettable
    end,
    method a-method(self, _, _, _, _, shadow body) block:
      saved-in-lam = in-lam
      in-lam := true
      body.visit(self)
      in-lam := saved-in-lam
      dummy-anf-lettable
    end,
    method a-id(self, shadow l, id) block:
      when in-lam and not(arg-used-in-lambda) and arg-names.member(id):
        arg-used-in-lambda := true
      end
      N.a-id(l, id)
    end
  })
  shadow compiler =
    if arg-used-in-lambda: compiler.{allow-tco: false}
    else: compiler
    end
  apploc = fresh-id(compiler-name("al"))
  use-loop = not(is-flat) and compiler.allow-tco and compiler.options.proper-tail-calls
  # `mints-tokens` is true exactly when this function is allowed to emit a bounce
  # token at a non-self tail call: it must be a real closure body (can-mint-tokens
  # — NOT the toplevel module fn or a cases-branch fn, whose results are consumed
  # directly and never driven) AND emitted async (a sync/flat fn can't return a
  # token to its non-awaiting caller without leaking it). `token-cell` records
  # whether the body actually minted one, so the caller (compile-a-lam) can choose
  # makeTailFunction (driver) vs makeFunction (zero overhead) — see the design doc.
  mints-tokens = can-mint-tokens and not(is-flat)
  local-compiler = compiler.{
    cur-step: step,
    cur-apploc: apploc,
    args: args.map(_.id).map(js-id-of),
    complete: complete-return,
    tail-pos: true,
    in-tco-loop: use-loop,
    mints-tokens: mints-tokens,
    cur-let-bind: none
  }
  # Shadow formals, assigned immediately to the "real" arg names (mirrors the
  # cont backend; lets us reassign args for TCO without touching parameters).
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
    | some(arity) =>
      if no-real-args: cl-empty
      else: arity-check(local-compiler.get-loc(l), arity, is-method)
      end
    | none => cl-empty
  end
  profile-enter =
    if local-compiler.options.should-profile:
      cl-sing(j-expr(rt-method("profileEnter", [clist: local-compiler.get-loc(l)])))
    else:
      cl-empty
    end
  # The fast-path fuel check: only await (and unwind the JS stack) when needed.
  fuel-check =
    if is-flat:
      cl-empty
    else:
      cl-sing(j-if1(rt-method("needsPause", cl-empty),
          j-block1(j-expr(j-await(rt-method("checkPause", cl-empty))))))
    end
  # Argument annotation contracts. Emitted at the top of the loop body so they run
  # on initial entry AND on every explicit-loop TCO re-entry — the cont backend
  # resets step to 0 on a tail self-call, so it re-checks args too (parity). A flat
  # arg ann checks synchronously; a non-flat one awaits (ann-check-stmts gates this
  # on the same flatness verdict that decided this function is sync vs async).
  arg-ann-stmts =
    if no-real-args: cl-empty
    else:
      for fold(acc from cl-empty, arg from args):
        cl-append(acc, ann-check-stmts(local-compiler, arg))
      end
    end
  visited-body-stmts = compile-aexpr-async(local-compiler, body)
  loop-body = fuel-check ^ cl-append(_, arg-ann-stmts) ^ cl-append(_, visited-body-stmts)
  body-stmts =
    if use-loop:
      cl-sing(j-while(j-true, j-block(loop-body)))
    else:
      loop-body
    end
  preamble = profile-enter ^ cl-append(_, arity-stmts) ^ cl-append(_, copy-formals-to-args)
  j-block(
    cl-cons(j-var(apploc, local-compiler.get-loc(l)),
      cl-append(preamble, body-stmts)))
end

fun compile-a-app(l :: N.Loc, f :: N.AVal, args :: List<N.AVal>,
    compiler,
    b :: Option<BindType>,
    opt-body :: Option<N.AExpr>,
    app-info :: A.AppInfo):

  is-safe-id = N.is-a-id(f) or N.is-a-id-safe-letrec(f)
  app-compiler = if is-safe-id and is-function-flat(compiler.flatness-env, f.id.key()):
    compile-flat-app
  else:
    compile-split-app
  end

  is-fn = is-safe-id and is-id-fn-name(compiler.flatness-env, f.id.key())
  app-compiler(l, compiler, b, f, args, opt-body, app-info, is-fn)
end

fun compile-a-lam(compiler, l :: Loc, name :: String, args :: List<N.ABind>, ret :: A.Ann, body :: N.AExpr, bind-opt :: Option<BindType>) block:
  is-flat = if is-some(bind-opt) and is-b-let(bind-opt.value):
    bind = bind-opt.value.value
    is-function-flat(compiler.flatness-env, bind.id.key())
  else:
    false
  end
  new-step = fresh-id(compiler-name("step"))
  temp = fresh-id(compiler-name("temp_lam"))
  len = args.length()
  # NOTE: args may be empty, so we need at least one name ("resumer") for the stack convention
  effective-args =
    if len > 0: args
    else: [list: N.a-bind(l, compiler.resumer, A.a-blank)]
    end
  # A fresh cell records whether this body actually minted a bounce token at some
  # tail position; if so the function value needs the driving `.app` wrapper
  # (makeTailFunction), otherwise it keeps app === appBody for zero overhead.
  token-cell = D.make-mutable-string-dict()
  fun-body = compile-fun-body(l, new-step, temp, compiler.{allow-tco: true, token-cell: token-cell}, effective-args, some(len), body, true, is-flat, false, true)
  fun-args = CL.map_list(lam(arg): formal-shadow-name(arg.id) end, effective-args)
  # Flat functions stay synchronous; everything else is an async function so its
  # body can `await` non-flat calls and the fuel check.
  the-fun =
    if is-flat: j-fun(J.next-j-fun-id(), make-fun-name(compiler, l), fun-args, fun-body)
    else: j-async-fun(J.next-j-fun-id(), make-fun-name(compiler, l), fun-args, fun-body)
    end
  maker = if token-cell.has-key-now("minted"): "makeTailFunction" else: "makeFunction" end
  c-exp(
    rt-method(maker, [clist: j-id(temp), j-str(name)]),
    [clist: j-var(temp, the-fun)])
end


fun compile-split-prim-app(l, compiler, opt-dest, f, args, opt-body):
  ans = compiler.cur-ans
  step = compiler.cur-step
  compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)
  {new-cases; after-app-label} = get-new-cases(compiler, opt-dest, opt-body, ans)
  c-block(
    j-block(
      # Update step before the call, so that if it runs out of gas,
      # the resumer goes to the right step
      [clist:
        j-expr(j-assign(step, after-app-label)),
        j-expr(j-assign(compiler.cur-apploc, compiler.get-loc(l)))] +
      [clist:
        j-expr(wrap-with-srcnode(l, j-assign(ans, rt-method(f, compiled-args)))),
        j-break]),
    new-cases)
end


fun compile-flat-prim-app(l, compiler, opt-dest, f, args, opt-body):
  ans = compiler.cur-ans
  compiled-args = CL.map_list(lam(a): a.visit(compiler).exp end, args)

  # Generate the code for calling the function
  call-code = j-expr(wrap-with-srcnode(l, j-assign(ans, rt-method(f, compiled-args))))

  # Compile the body of the let. We split it into two portions:
  # 1) the code that can be in the same "block" (or case region) and
  # 2) the rest of the case statements
  {remaining-code; new-cases} = cases (Option) opt-body:
    | some(body) =>
      get-remaining-code(compiler, opt-dest, body, ans)
    | none =>
      # Special case: there is no more code after this so just jump to the
      # special last block in the function
      body = j-block([clist:
          j-expr(j-assign(compiler.cur-step, compiler.cur-target)),
          j-break
        ])
      {body; cl-empty}
  end

  # Now merge the code for calling the function with the next block
  # (this is basically our optimization, since we're not starting a new case
  # for the next block)
  c-block(
    j-block(cl-cons(call-code, j-block-to-stmt-list(remaining-code))),
    new-cases)
end

fun compile-a-prim-app(l :: N.Loc, f :: String, args :: List<N.AVal>,
    compiler,
    b :: Option<BindType>,
    opt-body :: Option<N.AExpr>,
    app-info :: A.PrimAppInfo):

  app-compiler = if app-info.needs-step:
    compile-split-prim-app
  else:
    compile-flat-prim-app
  end
  app-compiler(l, compiler, b, f, args, opt-body)
end

fun compile-lettable(compiler, b :: Option<BindType>, e :: N.ALettable, opt-body :: Option<N.AExpr>, else-case :: (DAG.CaseResults -> DAG.CaseResults)):
  cases(N.ALettable) e:
    | a-prim-app(l2, f, args, app-info) =>
      compile-a-prim-app(l2, f, args, compiler, b, opt-body, app-info)
    | a-app(l2, f, args, app-info) =>
      compile-a-app(l2, f, args, compiler, b, opt-body, app-info)
    | a-method-app(l2, obj, m, args) =>
      compile-split-method-app(l2, compiler, b, obj, m, args, opt-body)
    | a-if(l2, cond, then, els) =>
      compile-split-if(compiler, b, cond, then, els, opt-body)
    | a-cases(l2, typ, val, branches, _else) =>
      compile-split-cases(compiler, l2, b, typ, val, branches, _else, opt-body)
    | a-update(l2, obj, fields) =>
      compile-split-update(compiler, l2, b, obj, fields, opt-body)
    | a-lam(l2, name, args, ret, body) =>
      compiled-e = compile-a-lam(compiler, l2, name, args, ret, body, b)
      else-case(compiled-e)
    | else =>
      compiled-e = e.visit(compiler)
      else-case(compiled-e)
  end
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
  method a-type-let(self, l, bind, body):
    cases(N.ATypeBind) bind:
      | a-type-bind(l2, name, ann) =>
        compiled-ann = compile-ann(ann, some(name.toname()), self)
        c-block(
          j-block(
            compiled-ann.other-stmts ^
            cl-snoc(_, j-var(js-id-of(name), compiled-ann.exp)) ^
            cl-append(_, compile-aexpr-async(self, body))),
          cl-empty)
      | a-newtype-bind(l2, name, nameb) =>
        brander-id = js-id-of(nameb)
        c-block(
          j-block(
            [clist:
              j-var(brander-id, rt-method("namedBrander", [clist: j-str(name.toname()), self.get-loc(l2)])),
              j-var(js-id-of(name), rt-method("makeBranderAnn", [clist: j-id(brander-id), j-str(name.toname())]))
            ] ^
            cl-append(_, compile-aexpr-async(self, body))),
          cl-empty)
    end
  end,
  method a-let(self, _, b :: N.ABind, e :: N.ALettable, body :: N.AExpr):
    # Bind e's value to b (e is not in tail position), then compile body in tail.
    bind-complete = lam(v): cl-sing(j-expr(j-assign(js-id-of(b.id), v))) end
    e-stmts = compile-lettable-async(self.{complete: bind-complete, tail-pos: false, cur-let-bind: some(b-let(b))}, e)
    body-and-ann = cl-append(ann-check-stmts(self, b), compile-aexpr-async(self, body))
    c-block(
      j-block(cl-append(cl-cons(j-var(js-id-of(b.id), undefined), e-stmts), body-and-ann)),
      cl-empty)
  end,
  method a-arr-let(self, _, b :: N.ABind, idx :: Number, e :: N.ALettable, body :: N.AExpr):
    bind-complete = lam(v): cl-sing(j-expr(j-bracket-assign(j-id(js-id-of(b.id)), j-num(idx), v))) end
    e-stmts = compile-lettable-async(self.{complete: bind-complete, tail-pos: false, cur-let-bind: some(b-array(b, idx))}, e)
    body-and-ann = cl-append(ann-check-stmts(self, b), compile-aexpr-async(self, body))
    c-block(
      j-block(cl-append(e-stmts, body-and-ann)),
      cl-empty)
  end,
  method a-var(self, l :: Loc, b :: N.ABind, e :: N.ALettable, body :: N.AExpr):
    # Compute e's value into a temp, then wrap it in a mutable {$var: ...} cell.
    temp = js-id-of(fresh-id(compiler-name("var_init")))
    temp-complete = lam(v): cl-sing(j-expr(j-assign(temp, v))) end
    e-stmts = compile-lettable-async(self.{complete: temp-complete, tail-pos: false, cur-let-bind: none}, e)
    var-decl = j-var(js-id-of(b.id), j-obj([clist: j-field("$var", j-id(temp))]))
    init-and-decl = cl-snoc(cl-cons(j-var(temp, undefined), e-stmts), var-decl)
    c-block(
      j-block(cl-append(init-and-decl, compile-aexpr-async(self, body))),
      cl-empty)
  end,
  method a-seq(self, _, e1, e2):
    # e1 is evaluated for effect (value discarded), then e2 in tail.
    discard-complete = lam(v): cl-sing(j-expr(v)) end
    e1-stmts = compile-lettable-async(self.{complete: discard-complete, tail-pos: false, cur-let-bind: none}, e1)
    c-block(
      j-block(e1-stmts ^ cl-append(_, compile-aexpr-async(self, e2))),
      cl-empty)
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
    # Tail position: the lettable's value flows to the current completion.
    c-block(j-block(compile-lettable-async(self, e)), cl-empty)
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
    step = fresh-id(compiler-name("step"))
    temp-full = fresh-id(compiler-name("temp_full"))
    len = args.length()
    # Methods participate in safe-for-space bouncing: a tail call inside the body
    # (to a function OR another method) mints a token, and the body is wrapped with
    # makeTailMethod (a driving full_meth) when it does. The token-cell records it,
    # exactly like compile-a-lam; methods are non-flat, so mints-tokens = can-mint.
    token-cell = D.make-mutable-string-dict()
    full-var =
      j-var(temp-full,
        j-async-fun(J.next-j-fun-id(), make-fun-name(self, l),
          CL.map_list(lam(a): formal-shadow-name(a.id) end, args),
          compile-fun-body(l, step, temp-full, self.{allow-tco: true, token-cell: token-cell}, args, some(len), body, true, false, true, true)
        ))
    maker = if token-cell.has-key-now("minted"): "makeTailMethod" else: "makeMethod" end
    method-expr = if len < 9:
      rt-method(string-append(maker, tostring(len - 1)), [clist: j-id(temp-full), j-str(name)])
    else:
      rt-method(maker + "N", [clist: j-id(temp-full), j-str(name)])
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

  free-ids = for map(k from freevars.keys-list-now().sort()):
    freevars.get-value-now(k)
  end
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
        # body-fun is an async function; await it directly (no trampoline).
        j-var(moduleVal, j-await(j-app(j-id(body-name), cl-empty))),
        j-expr(j-bracket-assign(rt-field("modules"), j-str(module-id), j-id(moduleVal))),
        j-return(j-id(moduleVal))])
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
    the-module = j-async-fun(J.next-j-fun-id(), make-fun-name(compiler, l),
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
  # The toplevel module fn is called directly (`await bodyName()`) and its result
  # is the module value, not driven through a `.app` wrapper, so it must NEVER mint
  # a token: can-mint-tokens = false. A tail-position call at program top drives to
  # a value via the callee's own `.app`.
  visited-body = compile-fun-body(l, step, toplevel-name,
    body-compiler, # resumer gets js-id-of'ed in compile-fun-body
    [list: resumer-bind], none, prog, true, false, false, false)
  toplevel-fun = j-async-fun(J.next-j-fun-id(), make-fun-name(body-compiler, l), [clist: formal-shadow-name(resumer)], visited-body)
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
