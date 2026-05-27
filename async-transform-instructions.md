The goal of this project is to add a new backend to pyret's compiler to use JS
async functions for the representation of compiled Pyret functions instead of
the bespoke regenerator-like transform that's in place right now. Eventually
the bespoke flow will eventually be deprecated. This will dramatically simplify
many aspects of the Pyret runtime. Some microbenchmarks will improve, others
will not – the goal is simplicity, not speed.

This transformation is significant and pervasive – it requires new code
generation in lang/, updated copies of runtime libraries in various js/
subdirectories.

## Repo Structure

This is a monorepo containing subdirectories for various components of the
Pyret ecosystem.

- lang/ contains the compiler and core runtime libraries. The existing
  infrastructure for controlled execution is split across anf-loop-compiler.arr
  and runtime.js. The most complex uses of these APIs is probably in the
  world/reactor infrastructure.
- code.pyret.org/ contains the web-based IDE for Pyret. It has a lot of code
  that *uses* the Pyret runtime functions like safeCall and runThunk. Either
  those interfaces need to be preserved atop the asynchronous style, or those
  client uses need to be rewritten to use the new backend. Keeping the runtime
  APIs externally consistent is the best outcome if possible.
- Other directories may have some small uses of the asynchronous runtime APIs,
  but are not as core and can likely be ignored for your work in getting the
  compiler infrastructure *correct*

## Strategy

This should be implemented as a *compiler flag* that selects a different
backend code generation and library linkage. Existing functionality should be
unchanged.

The desired strategy is outlined in a short email, async-email-demo.md, in the
root of this folder. It shows how to use async to get fiber-like behavior from
functions, where they run until exhausting "fuel" (like GAS/RUNGAS in
runtime.js). The overall strategy is:

- Make every generated Pyret function/method be async
- Make every Pyret function **call** (methods and functions) be `await f()`
- Change the kickoff/run infrastructure as necessary to support this
- Change runtime functions as necessary to use promises, async runtime
  functions, await, and so on to adapt to the new pattern

## Testing

- There are various `make` targets in `pyret-lang` that build and run the
  language-level tests. `make all-pyret-test` is particularly thorough. You can
  run single tests “by hand” using the `make %.jarr` rule with "EF=' '" to
  ensure tests aren't skipped (or roll the command yourself from examples in
  that file)
- `npm run mocha` in code.pyret.org/ runs selenium tests against more complex
  integration tests involving the browser. You can rerun targeted tests with
  `npm run mocha -- -g <pattern>`

The acceptance criterion is that the following succeed:

- in `lang/`, `make all-pyret tests`
- in `lang/`, `make new-bootstrap`
- in `code.pyret.org`, `npm run mocha`

These should succeed in their current form, *and* they succeed under building
with the new flag. You should add new make targets for this to demonstrate your
work.

## Work 

Don't change test files or existing make targets. You can add new test files.
You can add new make targets that build with your new flag. You can add new
files and new import statements and modify the compiler to route the flag to
your newly-added phases. You can copy and/or modify runtime files. Prefer
copying and keeping diffs in existing files small and about configuration
rather than making invasive changes.

Make a commit, with a reflection in the commit message, each time you run the
tests on a significant increment. You can choose the exact timing and commit
messages, but roughtly respect:

- If you ran tests (even a single one) 5 or more times to debug something, make
  a commit
- If you copy a file, make a commit of the copy before you start editing it
- If you write more than 100 lines of code and run the tests, make a commit

Stop if you think your task has become impossible or intractable. Write into
OFF-RUBRIC.md if this happens, and come back for guidance.

If you succeed, write in REPORT.md the overally summary of your work.

## Lessons Learned

You are not the first agent to attempt this task. I am sure it is tractable,
but there are some gotchas. These are lessons from previous attempts that
rabbit-holed:

- Make *copies* of anf-loop-compiler and runtime.js to wire in. Don't edit
  what's there. You're also free to write an *entirely new* backend .arr file
  or runtime file if it's easier than starting with a copy. Unclear which is
  better; Joe's guess is that writing a new codegen .arr file is a good idea,
  copying runtime.js is probably better than starting from scratch.
- Constructors have delicate JIT/staged metaprogramming. Feel free to remove
  this so that you don't have to reason “across the evals”, which is hard.
  That's a representative example: in general it's OK to make changes to the
  codegen/runtime interplay that don't change e.g. the underlying value
  representations, exposed interfaces, or behavior of libraries.
- If you're not careful, various parts of the infrastructure can end up
  “polyglot”, where earlier phases get non-async compilation linked in. DO NOT
  try to implement a runtime that can handle both the current Cont-based stack
  management *and* async. Figure out how to configure/build/flag your way
  around this issue so you don't have to do combined runtime thinking. e.g. you
  may want to run tests from phaseB libraries where phaseA uses the flag to
  generate the correct version of compiled files for the async backend. If you
  find a helper outside of runtime that refers to Cont-style constructs
  explicitly, try to rewrite it in terms of the runtime's shared APIs rather
  than making it polyglot.
- This point about “polyglot” is especially relevant in test-compile-lib and
  other tests that call into the compiler from test files. These are tricky
  because of managing cached copies of builtin modules (compiled with the right
  flags) and otherwise. Come up with a strategy for this early.
- Don't drop the notion of fuel/rungas unless you can prove that the user would
  still be able to get an event in (e.g. click a "Stop" button in the IDE).

You can see the source, git history, and reports of past attempts in
`../attempts/*`. DO NOT start from those attempts, read their reports and
off-rubric results. You were invoked because I want to *try again* but
incorporating the lessons learned. For example, some attempts may seem
impressively close but actually set fuel to Infinity which doesn't seem like it
guarantees stoppability. Pay careful attention to the requirements, learn from
where they ended up.

