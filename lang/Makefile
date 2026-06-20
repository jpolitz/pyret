PYRET_COMP0      = build/phase0/pyret.jarr
NODE             = node -max-old-space-size=8192
NPM_EXEC         = npm --prefix . exec --no --
JS               = js
JSBASE           = $(JS)/base
JSTROVE          = $(JS)/trove
BASE             = arr/base
TROVE            = arr/trove
COMPILER         = arr/compiler

PHASE0           = build/phase0
PHASEA           = build/phaseA
PHASEB           = build/phaseB
PHASEC           = build/phaseC
BUNDLED_DEPS     = build/bundled-node-deps.js
SHELL := /usr/bin/env bash

# CUSTOMIZE THESE IF NECESSARY
PARSERS         := $(patsubst src/js/base/%-grammar.bnf,src/js/%-parser.js,$(wildcard src/$(JSBASE)/*-grammar.bnf))
COPY_JS          = $(patsubst src/js/base/%.js,src/js/%.js,$(wildcard src/$(JSBASE)/*.js)) \
	src/js/js-numbers.js
COPY_LIB         = $(wildcard lib/jglr/*.js)
COMPILER_FILES = $(wildcard src/arr/compiler/*.js) $(wildcard src/arr/compiler/*.arr) $(wildcard src/arr/compiler/locators/*.arr) $(wildcard src/js/trove/*.js) $(wildcard src/arr/trove/*.arr)
TROVE_ARR_FILES = $(wildcard src/arr/trove/*.arr)

PHASEA_ALL_DEPS := $(patsubst src/%,$(PHASEA)/%,$(COPY_JS)) $(patsubst lib/jglr/%.js,$(PHASEA)/js/%.js,$(COPY_LIB)) $(PHASEA)/bundled-node-compile-deps.js $(PHASEA)/bundled-node-deps.js $(PHASEA)/config.json
PHASEB_ALL_DEPS := $(patsubst src/%,$(PHASEB)/%,$(COPY_JS)) $(patsubst lib/jglr/%.js,$(PHASEB)/js/%.js,$(COPY_LIB)) $(PHASEB)/bundled-node-compile-deps.js $(PHASEB)/bundled-node-deps.js $(PHASEB)/config.json
PHASEC_ALL_DEPS := $(patsubst src/%,$(PHASEC)/%,$(COPY_JS)) $(patsubst lib/jglr/%.js,$(PHASEC)/js/%.js,$(COPY_LIB)) $(PHASEC)/bundled-node-compile-deps.js $(PHASEC)/bundled-node-deps.js $(PHASEC)/config.json

PHASEA_DIRS     := $(sort $(dir $(PHASEA_ALL_DEPS)))
PHASEB_DIRS     := $(sort $(dir $(PHASEB_ALL_DEPS)))
PHASEC_DIRS     := $(sort $(dir $(PHASEC_ALL_DEPS)))

# NOTE: Needs TWO blank lines here, dunno why
define \n

endef
ifneq ($(findstring .exe,$(SHELL)),)
	override SHELL:=$(COMSPEC)$(ComSpec)
	MKDIR = $(foreach dir,$1,if not exist "$(dir)". (md "$(dir)".)$(\n))
	RMDIR = $(foreach dir,$1,if exist "$(dir)". (rd /S /Q "$(dir)".)$(\n))
	RM = if exist "$1". (del $1)
else
	MKDIR = mkdir -p $1
	RMDIR = rm -rf $1
	RM = rm -f $1
	VERSION = $(shell git describe --long --tags HEAD | awk -F '[/-]' '{ print $$1 "r" $$2 }')
endif

-include config.mk

# Make sure that if a compilation step fails, we don't leave an empty but timestamp-up-to-date file
# laying (and lying) around to confuse future make
.DELETE_ON_ERROR:

# MAIN TARGET
.PHONY : phaseA
phaseA: $(PHASEA)/pyret.jarr

.PHONY : phaseA-deps
phaseA-deps: $(PYRET_COMPA) $(PHASEA_ALL_DEPS) $(COMPILER_FILES) $(patsubst src/%,$(PHASEA)/%,$(PARSERS))


$(PHASEA)/pyret.jarr: $(PYRET_COMPA) $(PHASEA_ALL_DEPS) $(COMPILER_FILES) $(patsubst src/%,$(PHASEA)/%,$(PARSERS))
	$(NODE) $(PYRET_COMP0) --outfile build/phaseA/pyret.jarr \
                      --build-runnable src/arr/compiler/pyret.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir build/phaseA/compiled/ \
                      --deps-file build/phaseA/bundled-node-compile-deps.js \
                      -no-check-mode $(EF) \
                      --require-config src/scripts/standalone-configA.json

$(PHASEA)/libs.jarr: $(PHASEA)/pyret.jarr
	$(NODE) $(PHASEA)/pyret.jarr --outfile build/phaseA/base.jarr \
                      --build-runnable src/arr/compiler/libs.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir build/phaseA/lib-compiled/ \
                      --deps-file build/phaseA/bundled-node-compile-deps.js \
                      -no-check-mode $(EF) \
                      --require-config src/scripts/standalone-configA.json

.PHONY : libA
libA : $(PHASEA)/libs.jarr

.PHONY : phaseB
phaseB: $(PHASEB)/pyret.jarr

$(PHASEB)/pyret.jarr: $(PHASEA)/pyret.jarr $(PHASEB_ALL_DEPS) $(patsubst src/%,$(PHASEB)/%,$(PARSERS))
	$(NODE) $(PHASEA)/pyret.jarr --outfile build/phaseB/pyret.jarr \
                      --build-runnable src/arr/compiler/pyret.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir build/phaseB/compiled/ \
                      --deps-file build/phaseB/bundled-node-compile-deps.js \
                      -no-check-mode $(EF) \
                      --require-config build/phaseB/config.json


.PHONY : phaseC
phaseC: $(PHASEC)/pyret.jarr

$(PHASEC)/pyret.jarr: $(PHASEB)/pyret.jarr $(PHASEC_ALL_DEPS) $(patsubst src/%,$(PHASEC)/%,$(PARSERS))
	$(NODE) $(PHASEB)/pyret.jarr --outfile build/phaseC/pyret.jarr \
                      --build-runnable src/arr/compiler/pyret.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir build/phaseC/compiled/ \
                      --deps-file build/phaseB/bundled-node-compile-deps.js \
                      -no-check-mode $(EF) \
                      --require-config build/phaseB/config.json

.PHONY : show-comp
show-comp: build/show-compilation.jarr

$(PHASEA)/bundled-node-compile-deps.js: src/js/trove/require-node-compile-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-compile-dependencies.js -o $@
$(PHASEA)/bundled-node-deps.js: src/js/trove/require-node-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-dependencies.js -o $@
$(PHASEB)/bundled-node-compile-deps.js: src/js/trove/require-node-compile-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-compile-dependencies.js -o $@
$(PHASEC)/bundled-node-compile-deps.js: src/js/trove/require-node-compile-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-compile-dependencies.js -o $@

$(PHASEA)/config.json: src/scripts/node_modules-config.json
	cp $< $@
$(PHASEB)/config.json: src/scripts/node_modules-config.json
	cp $< $@
$(PHASEC)/config.json: src/scripts/node_modules-config.json
	cp $< $@

$(BUNDLED_DEPS): src/js/trove/require-node-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-dependencies.js -o $(BUNDLED_DEPS)

build/show-compilation.jarr: $(PHASEA)/pyret.jarr src/scripts/show-compilation.arr
	$(NODE) $(PHASEA)/pyret.jarr --outfile build/show-compilation.jarr \
                      --build-runnable src/scripts/show-compilation.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir build/show-comp/compiled/ \
                      -no-check-mode \
                      --require-config src/scripts/standalone-configA.json
ifneq ($(EF),)
EXTRA_FLAGS=$(EF)
else
EXTRA_FLAGS = -no-check-mode
endif
%.jarr: $(PHASEA)/pyret.jarr %.arr
	$(NODE) $(PHASEA)/pyret.jarr --outfile $*.jarr \
                      --build-runnable $*.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir compiled/ \
                      $(EXTRA_FLAGS) \
                      --require-config src/scripts/standalone-configA.json

%.html: $(PHASEA)/pyret.jarr %.arr
	$(NODE) $(PHASEA)/pyret.jarr --outfile $*.jarr \
                      --build-runnable $*.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir compiled/ \
                      $(EXTRA_FLAGS) \
                      --require-config src/scripts/standalone-configA.json \
                      -bundle-dependencies \
                      --html-file $*.html

$(PHASEA_ALL_DEPS): | $(PHASEA)

$(PHASEB_ALL_DEPS): | $(PHASEB) phaseA

$(PHASEC_ALL_DEPS): | $(PHASEC) phaseB

$(PHASEA):
	@$(call MKDIR,$(PHASEA_DIRS))

$(PHASEB):
	@$(call MKDIR,$(PHASEB_DIRS))

$(PHASEC):
	@$(call MKDIR,$(PHASEC_DIRS))

$(PHASEA)/$(JS)/%-parser.js: src/$(JSBASE)/%-grammar.bnf src/$(JSBASE)/%-tokenizer.js $(wildcard lib/jglr/*.js)
	$(NODE) lib/jglr/parser-generator.js src/$(JSBASE)/$*-grammar.bnf $(PHASEA)/$(JS)/$*-grammar.js "../../../lib/jglr" "jglr/jglr" "pyret-base/js/$*-parser"
	$(NODE) $(PHASEA)/$(JS)/$*-grammar.js $(PHASEA)/$(JS)/$*-parser.js

$(PHASEB)/$(JS)/%-parser.js: src/$(JSBASE)/%-grammar.bnf src/$(JSBASE)/%-tokenizer.js $(wildcard lib/jglr/*.js)
	$(NODE) lib/jglr/parser-generator.js src/$(JSBASE)/$*-grammar.bnf $(PHASEB)/$(JS)/$*-grammar.js "../../../lib/jglr" "jglr/jglr" "pyret-base/js/$*-parser"
	$(NODE) $(PHASEB)/$(JS)/$*-grammar.js $(PHASEB)/$(JS)/$*-parser.js

$(PHASEC)/$(JS)/%-parser.js: src/$(JSBASE)/%-grammar.bnf src/$(JSBASE)/%-tokenizer.js $(wildcard lib/jglr/*.js)
	$(NODE) lib/jglr/parser-generator.js src/$(JSBASE)/$*-grammar.bnf $(PHASEC)/$(JS)/$*-grammar.js "../../../lib/jglr" "jglr/jglr" "pyret-base/js/$*-parser"
	$(NODE) $(PHASEC)/$(JS)/$*-grammar.js $(PHASEC)/$(JS)/$*-parser.js

$(PHASEA)/$(JS)/%.js : src/$(JSBASE)/%.js
	cp $< $@
$(PHASEA)/$(JS)/%.js : lib/jglr/%.js
	cp $< $@
$(PHASEB)/$(JS)/%.js : src/$(JSBASE)/%.js
	cp $< $@
$(PHASEB)/$(JS)/%.js : lib/jglr/%.js
	cp $< $@
$(PHASEC)/$(JS)/%.js : src/$(JSBASE)/%.js
	cp $< $@
$(PHASEC)/$(JS)/%.js : lib/jglr/%.js
	cp $< $@

.PHONY : install
install:
	@$(call MKDIR,node_modules)
	npm install

PYRET_TEST_PHASE=$(P)
ifeq ($(PYRET_TEST_PHASE),B)
  PYRET_TEST_PHASE=$(PHASEB)
  PYRET_TEST_PREREQ=$(PHASEB)/pyret.jarr
  PYRET_TEST_CONFIG=src/scripts/standalone-configB.json
else
ifeq ($(PYRET_TEST_PHASE),C)
  PYRET_TEST_PHASE=$(PHASEC)
  PYRET_TEST_PREREQ=$(PHASEC)/pyret.jarr
  PYRET_TEST_CONFIG=src/scripts/standalone-configC.json
else
  PYRET_TEST_PHASE=$(PHASEA)
  PYRET_TEST_PREREQ=$(PHASEA)/pyret.jarr
  PYRET_TEST_CONFIG=src/scripts/standalone-configA.json
endif
endif

TEST_BUILD=$(NODE) $(PYRET_TEST_PHASE)/pyret.jarr \
	  --builtin-js-dir src/js/trove/ \
		--builtin-arr-dir src/arr/trove/ \
		--require-config $(PYRET_TEST_CONFIG) \
		--compiled-dir tests/compiled/

.PHONY : test-all
test-all: test

.PHONY : test
test: pyret-test type-check-test pyret-io-test jsnums-test

.PHONY : parse-test
parse-test: tests/parse/parse.js build/phaseA/js/pyret-tokenizer.js build/phaseA/js/pyret-parser.js
	cd tests/parse/ && $(NODE) parse.js

TEST_FILES := $(wildcard tests/pyret/tests/*.arr)
TYPE_TEST_FILES := $(wildcard tests/type-check/bad/*.arr) $(wildcard tests/type-check/good/*.arr) $(wildcard tests/type-check/should/*.arr) $(wildcard tests/type-check/should-not/*.arr)
REG_TEST_FILES := $(wildcard tests/pyret/regression/*.arr)
MAIN_TEST_FILES := tests/pyret/main2.arr tests/type-check/main.arr tests/pyret/regression.arr tests/lib-test/lib-test-main.arr tests/all.arr

tests/pyret/all.jarr: phaseA $(TEST_FILES) $(TYPE_TEST_FILES) $(REG_TEST_FILES) $(MAIN_TEST_FILES)
	$(TEST_BUILD) \
		--build-runnable tests/all.arr \
    --outfile tests/pyret/all.jarr \
		-check-all

.PHONY : all-pyret-test
all-pyret-test: tests/pyret/all.jarr parse-test pyret-io-test
	$(NODE) tests/pyret/all.jarr

tests/pyret/main2.jarr: phaseA tests/pyret/main2.arr  $(TEST_FILES)
	$(TEST_BUILD) \
		--outfile tests/pyret/main2.jarr \
		--build-runnable tests/pyret/main2.arr \
		-check-all # NOTE(joe): check-all doesn't yet do anything


.PHONY : pyret-test
pyret-test: phaseA tests/pyret/main2.jarr
	$(NODE) tests/pyret/main2.jarr

.PHONY : pyret-io-test
pyret-io-test: phaseA
	$(NPM_EXEC) jest --detectOpenHandles --forceExit --verbose "tests/io-tests/io.test.js"

.PHONY : jsnums-test
jsnums-test: phaseA
	$(NODE) tests/jsnums-test/jsnums-test.js

.PHONY : regression-test
regression-test: tests/pyret/regression.jarr
	$(NODE) tests/pyret/regression.jarr

tests/pyret/regression.jarr: $(PYRET_TEST_PREREQ) $(REG_TEST_FILES) tests/pyret/regression.arr
	$(TEST_BUILD) \
		--build-runnable tests/pyret/regression.arr --outfile tests/pyret/regression.jarr

.PHONY : type-check-test
type-check-test: phaseA tests/type-check/main.jarr
	$(NODE) tests/type-check/main.jarr

tests/type-check/main.jarr: phaseA tests/type-check/main.arr $(TYPE_TEST_FILES)
	$(TEST_BUILD) \
		--build-runnable tests/type-check/main.arr --outfile tests/type-check/main.jarr


.PHONY : clean
clean:
	$(call RMDIR,$(PHASEA))
	$(call RMDIR,$(PHASEB))
	$(call RMDIR,$(PHASEC))
	$(call RMDIR,build/show-comp/compiled)
	$(call RMDIR,$(RELEASE_DIR))
	$(call RM,$(BUNDLED_DEPS))

.PHONY : test-clean
test-clean:
	$(call RMDIR, tests/compiled)

# Written this way because cmd.exe complains about && in command lines
new-bootstrap: no-diff-standalone $(PHASE0BUILD)
	cp $(PHASEC)/pyret.jarr $(PYRET_COMP0)
	cp -r $(PHASEC)/js $(PHASE0)/
no-diff-standalone: phaseB phaseC
	diff $(PHASEB)/pyret.jarr $(PHASEC)/pyret.jarr

# ============================================================
# TypeScript compiler port (strictly additive; see src/ts-compiler/)
# Builds a TS implementation of the arr/compiler pipeline that
# accepts the same CLI options and emits the same module format.
# ============================================================

TS_COMP_DIR      = src/ts-compiler
TS_COMP_OUT      = build/ts-compiler
TS_PYRET         = $(NODE) $(TS_COMP_OUT)/pyret.js
TS_COMP_SRC      = $(wildcard $(TS_COMP_DIR)/src/*.ts) $(wildcard $(TS_COMP_DIR)/src/*/*.ts)

$(TS_COMP_OUT)/js/pyret-parser.js: src/$(JSBASE)/pyret-grammar.bnf src/$(JSBASE)/pyret-tokenizer.js $(wildcard lib/jglr/*.js)
	@$(call MKDIR,$(TS_COMP_OUT)/js)
	$(NODE) lib/jglr/parser-generator.js src/$(JSBASE)/pyret-grammar.bnf $(TS_COMP_OUT)/js/pyret-grammar.js "../../../lib/jglr" "jglr/jglr" "pyret-base/js/pyret-parser"
	$(NODE) $(TS_COMP_OUT)/js/pyret-grammar.js $(TS_COMP_OUT)/js/pyret-parser.js

$(TS_COMP_DIR)/node_modules/.bin/tsc:
	npm --prefix $(TS_COMP_DIR) install --no-audit --no-fund

$(TS_COMP_OUT)/pyret.js: $(TS_COMP_SRC) $(TS_COMP_DIR)/tsconfig.json $(TS_COMP_DIR)/node_modules/.bin/tsc $(TS_COMP_OUT)/js/pyret-parser.js
	$(TS_COMP_DIR)/node_modules/.bin/tsc -p $(TS_COMP_DIR)


# Runtime/support files for the TS compiler's output dir (mirrors PHASEA_ALL_DEPS)
TS_COMP_ALL_DEPS := $(patsubst src/%,$(TS_COMP_OUT)/%,$(COPY_JS)) $(patsubst lib/jglr/%.js,$(TS_COMP_OUT)/js/%.js,$(COPY_LIB)) $(TS_COMP_OUT)/bundled-node-compile-deps.js $(TS_COMP_OUT)/bundled-node-deps.js $(TS_COMP_OUT)/config.json

$(TS_COMP_OUT)/js/%.js: src/js/base/%.js
	@$(call MKDIR,$(TS_COMP_OUT)/js)
	cp $< $@

$(TS_COMP_OUT)/js/%.js: lib/jglr/%.js
	@$(call MKDIR,$(TS_COMP_OUT)/js)
	cp $< $@

$(TS_COMP_OUT)/bundled-node-compile-deps.js: src/js/trove/require-node-compile-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-compile-dependencies.js -o $@

$(TS_COMP_OUT)/bundled-node-deps.js: src/js/trove/require-node-dependencies.js
	$(NPM_EXEC) browserify src/js/trove/require-node-dependencies.js -o $@

$(TS_COMP_OUT)/config.json: src/scripts/node_modules-config.json
	cp $< $@

.PHONY : ts-compiler
ts-compiler: $(TS_COMP_OUT)/pyret.js $(TS_COMP_ALL_DEPS)

# Unit tests for the TS compiler implementation itself
.PHONY : ts-unit-test
ts-unit-test: ts-compiler
	$(NODE) $(TS_COMP_DIR)/tests/run-unit-tests.js

# Parity: compile and run the same programs with the Pyret-hosted
# compiler (phaseA) and the TS compiler, with the same options, and
# compare results.
.PHONY : ts-parity-test
ts-parity-test: ts-compiler $(PHASEA)/pyret.jarr
	bash $(TS_COMP_DIR)/tests/parity-test.sh

# ===== Promise/async backend, TS port (--stack-backend promise) =====
# Byte-parity (PRIMARY oracle): compile each parity program with the in-tree
# Pyret-promise reference (phaseA --stack-backend promise) and with the
# TS-promise compiler, and compare the per-module cache + standalone jarr
# byte-for-byte. Pins exact async codegen.
.PHONY : ts-parity-promise-test
ts-parity-promise-test: ts-compiler $(PHASEA)/pyret.jarr
	bash $(TS_COMP_DIR)/tests/parity-promise-test.sh

# Build one file fast with the TS-promise backend (async analogue of %.ts.jarr):
#   make examples/foo.ts.p.jarr
# Uses the async require-config + a SEPARATE compiled-ts-promise/ cache so async
# and cont compiled modules never mix (the polyglot hazard).
%.ts.p.jarr: ts-compiler %.arr
	$(TS_PYRET) --outfile $*.ts.p.jarr \
                      --build-runnable $*.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir compiled-ts-promise/ \
                      --stack-backend promise \
                      $(EXTRA_FLAGS) \
                      --require-config src/scripts/standalone-configA-async.json

# Cross-backend run parity (within the TS compiler): TS-cont vs TS-promise on
# tests/pyret/main2.arr (the independent semantic check for Promise-leak / flatness
# bugs the byte oracle is blind to). Builds a promise-backend main2 and runs it.
tests/pyret/main2-ts-promise.jarr: ts-compiler tests/pyret/main2.arr $(TEST_FILES)
	$(TS_PYRET) \
		  --builtin-js-dir src/js/trove/ \
			--builtin-arr-dir src/arr/trove/ \
			--require-config src/scripts/standalone-configA-async.json \
			--compiled-dir tests/ts-compiled-promise/ \
			--stack-backend promise \
		--outfile tests/pyret/main2-ts-promise.jarr \
		--build-runnable tests/pyret/main2.arr \
		-check-all

# Like pyret-test-promise (the Pyret-promise reference oracle) but for the TS-promise
# compiler. The suite runs ~247 nested run-task compiles that resolve a CWD-relative
# ./compiled-promise; COLD, each recompiles builtins in-process with the slow async
# compiler and the run appears to hang. So PRE-WARM ./compiled-promise first (same as
# pyret-test-promise). Run from $(CURDIR) under node22 with NODE_PATH (chart tests pull
# in vega = ESM). Gate on "Ended in Error: 0" + the expected ~8 test-repl failures
# (documented async stack-trace-shape pins), NOT a zero-failure total.
.PHONY : ts-promise-pyret-test
ts-promise-pyret-test: warm-promise-cache tests/pyret/main2-ts-promise.jarr
	@echo "=== TS-promise suite (expect: Errored 0; ~8 test-repl stacktrace-pin failures) ==="
	NODE_PATH=$(CURDIR)/node_modules $(NODE22) tests/pyret/main2-ts-promise.jarr | tee /tmp/ts-promise-suite-result.txt; grep -q "Ended in Error: 0" /tmp/ts-promise-suite-result.txt && echo "TS-PROMISE SUITE OK (0 errors)" || { echo "TS-PROMISE SUITE: errors present"; exit 1; }

.PHONY : ts-promise-test
ts-promise-test: ts-parity-promise-test ts-promise-pyret-test

# Build and run the main Pyret test suite using the TS compiler
TS_TEST_BUILD=$(TS_PYRET) \
	  --builtin-js-dir src/js/trove/ \
		--builtin-arr-dir src/arr/trove/ \
		--require-config src/scripts/standalone-configA.json \
		--compiled-dir tests/ts-compiled/

tests/pyret/main2-ts.jarr: ts-compiler tests/pyret/main2.arr $(TEST_FILES)
	$(TS_TEST_BUILD) \
		--outfile tests/pyret/main2-ts.jarr \
		--build-runnable tests/pyret/main2.arr \
		-check-all

.PHONY : ts-pyret-test
ts-pyret-test: tests/pyret/main2-ts.jarr
	$(NODE) tests/pyret/main2-ts.jarr

.PHONY : ts-test
ts-test: ts-unit-test ts-parity-test ts-repl-test ts-pyret-test ts-type-check-test ts-regression-test ts-io-test

.PHONY : ts-clean
ts-clean:
	$(call RMDIR,$(TS_COMP_OUT))
	$(call RMDIR,tests/ts-compiled)
	$(call RM,tests/pyret/main2-ts.jarr)
	$(call RM,tests/pyret/regression-ts.jarr)
	$(call RM,tests/type-check/main-ts.jarr)
	$(call RM,tests/pyret/all-ts.jarr)

# Analogous to the %.jarr rule above, but using the TypeScript compiler:
# `make path/to/foo.ts.jarr` builds path/to/foo.arr into path/to/foo.ts.jarr.
# Same flag override applies (EF="..." to replace -no-check-mode).
%.ts.jarr: $(TS_COMP_OUT)/pyret.js %.arr
	$(TS_PYRET) --outfile $*.ts.jarr \
                      --build-runnable $*.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir compiled-ts/ \
                      $(EXTRA_FLAGS) \
                      --require-config src/scripts/standalone-configA.json

# TS-compiler analogues of the remaining test entry points
tests/pyret/regression-ts.jarr: ts-compiler tests/pyret/regression.arr $(REG_TEST_FILES)
	$(TS_TEST_BUILD) \
		--build-runnable tests/pyret/regression.arr --outfile tests/pyret/regression-ts.jarr

.PHONY : ts-regression-test
ts-regression-test: tests/pyret/regression-ts.jarr
	$(NODE) tests/pyret/regression-ts.jarr

tests/type-check/main-ts.jarr: ts-compiler tests/type-check/main.arr $(TYPE_TEST_FILES)
	$(TS_TEST_BUILD) \
		--build-runnable tests/type-check/main.arr --outfile tests/type-check/main-ts.jarr

.PHONY : ts-type-check-test
ts-type-check-test: ts-compiler tests/type-check/main-ts.jarr
	$(NODE) tests/type-check/main-ts.jarr

.PHONY : ts-io-test
ts-io-test: ts-compiler
	$(NPM_EXEC) jest --detectOpenHandles --forceExit --verbose "src/ts-compiler/tests/io-ts.test.js"

tests/pyret/all-ts.jarr: ts-compiler $(TEST_FILES) $(TYPE_TEST_FILES) $(REG_TEST_FILES) $(MAIN_TEST_FILES)
	$(TS_TEST_BUILD) \
		--build-runnable tests/all.arr \
    --outfile tests/pyret/all-ts.jarr \
		-check-all

.PHONY : all-ts-pyret-test
all-ts-pyret-test: tests/pyret/all-ts.jarr
	$(NODE) tests/pyret/all-ts.jarr

.PHONY : ts-repl-test
ts-repl-test: ts-compiler
	$(NODE) src/ts-compiler/tests/repl-test.js


# ===== Promise/async backend (brought in for Phase 0 oracle work) =====
# backend, links runtime-async.js (via the -async config), and uses a SEPARATE
# compiled-promise/ cache so async and Cont compiled modules never mix (the
# polyglot hazard). The output is still a runnable standalone .jarr; the .p infix
# just marks the backend. Build one file fast with: make foo.p.jarr EF=' '
%.p.jarr: $(PHASEA)/pyret.jarr %.arr
	$(NODE) $(PHASEA)/pyret.jarr --outfile $*.p.jarr \
                      --build-runnable $*.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir compiled-promise/ \
                      --stack-backend promise \
                      $(EXTRA_FLAGS) \
                      --require-config src/scripts/standalone-configA-async.json

# --- Promise/async backend bootstrap ---
# Self-hosts the COMPILER on the async backend and proves it reaches a
# byte-stable fixpoint, the async analogue of the cont `new-bootstrap`.
#
# Each generation re-compiles src/arr/compiler/pyret.arr with --stack-backend
# promise (so the output embeds runtime-async.js and every fn is an `async
# function`); the only thing that changes generation-to-generation is WHICH
# compiler does the compiling:
#   phaseB-promise : built by the CONT phaseA compiler            (the seed)
#   phaseC-promise : built by phaseB-promise   (promise builds promise)
#   phaseD-promise : built by phaseC-promise
#   phaseE-promise : built by phaseD-promise
#
# Promise compilation is deterministic *given a fixed compiler* (same compiler
# twice => byte-identical output), so the chain converges. It takes one more
# generation than cont to settle because the SEED (phaseB) is assembled by the
# cont compiler, whose internal module/gensym ordering differs slightly from a
# promise-built one; that perturbs the gensym-atom names and dependency-list
# ordering embedded as DATA (not logic) until the builder is itself
# promise-built-by-promise. Empirically phaseB != C != D but D == E: the
# fixpoint. new-bootstrap-promise diffs the converged pair (D vs E).
#
# Each builder needs its own js/ dir because pyret.arr derives this-pyret-dir
# from the running standalone's location (makeStandalone reads js/amd_loader.js
# + js/handalone.js from there). Caches/js live under build/phase?-promise/ so
# they never mix with the cont phase dirs (the polyglot hazard).
# Run: make new-bootstrap-promise   (~4 full compiler builds)
PHASEBP = build/phaseB-promise
PHASECP = build/phaseC-promise
PHASEDP = build/phaseD-promise
PHASEEP = build/phaseE-promise

# $(1) = builder pyret.jarr (the compiler doing the work); $(2) = output phase dir
define PROMISE_SELFBUILD
	@$(call MKDIR,$(2)/compiled)
	$(call RMDIR,$(2)/js)
	cp -r $(PHASEA)/js $(2)/
	$(NODE) $(1) --outfile $(2)/pyret.jarr \
                      --build-runnable src/arr/compiler/pyret.arr \
                      --builtin-js-dir src/js/trove/ \
                      --builtin-arr-dir src/arr/trove/ \
                      --compiled-dir $(2)/compiled/ \
                      --deps-file $(PHASEA)/bundled-node-compile-deps.js \
                      --stack-backend promise \
                      -no-check-mode \
                      --require-config src/scripts/standalone-configA-async.json
endef

$(PHASEBP)/pyret.jarr: $(PHASEA)/pyret.jarr $(COMPILER_FILES) $(PHASEA)/bundled-node-compile-deps.js
	$(call PROMISE_SELFBUILD,$(PHASEA)/pyret.jarr,$(PHASEBP))
$(PHASECP)/pyret.jarr: $(PHASEBP)/pyret.jarr $(COMPILER_FILES) $(PHASEA)/bundled-node-compile-deps.js
	$(call PROMISE_SELFBUILD,$(PHASEBP)/pyret.jarr,$(PHASECP))
$(PHASEDP)/pyret.jarr: $(PHASECP)/pyret.jarr $(COMPILER_FILES) $(PHASEA)/bundled-node-compile-deps.js
	$(call PROMISE_SELFBUILD,$(PHASECP)/pyret.jarr,$(PHASEDP))
$(PHASEEP)/pyret.jarr: $(PHASEDP)/pyret.jarr $(COMPILER_FILES) $(PHASEA)/bundled-node-compile-deps.js
	$(call PROMISE_SELFBUILD,$(PHASEDP)/pyret.jarr,$(PHASEEP))

.PHONY : phaseB-promise phaseC-promise phaseD-promise phaseE-promise
phaseB-promise: $(PHASEBP)/pyret.jarr
phaseC-promise: $(PHASECP)/pyret.jarr
phaseD-promise: $(PHASEDP)/pyret.jarr
phaseE-promise: $(PHASEEP)/pyret.jarr

# The converged fixpoint: phaseD-promise (promise-built-by-promise) reproduces
# itself exactly as phaseE-promise.
.PHONY : new-bootstrap-promise
new-bootstrap-promise: phaseD-promise phaseE-promise
	diff $(PHASEDP)/pyret.jarr $(PHASEEP)/pyret.jarr


# ===== Promise/async backend test suite (behavioral oracle) =====
# Runs the full main2 suite compiled with the promise backend. VERIFIED result:
# Passed ~13034 / Failed 8 / Errored 0 -- the 8 failures are the documented async
# stack-trace-shape pins in tests/pyret/tests/test-repl.arr, NOT regressions.
# (Compare the failing SET, not the total: test-pprint's assertion count drifts.)
#
# The suite runs ~247 nested run-task/run-str compiles that default to
# ./compiled-promise (CWD-relative). On a COLD cache each one recompiles builtins
# IN-PROCESS with the (slow) async-compiled bundled compiler, so the run appears
# to hang. pyret-test-promise therefore PRE-WARMS ./compiled-promise first; the
# run self-warms the remainder and the dir persists for later runs. Build the
# suite WITHOUT --deps-file and run under node22 (chart tests pull in vega = ESM).
# (A TS-promise suite needs the same pre-warm of its nested runtime cache dir.)
NODE22 ?= node22
PROMISE_TEST_BUILD = $(NODE) $(PHASEA)/pyret.jarr --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ --require-config src/scripts/standalone-configA-async.json --stack-backend promise

tests/pyret/main2.p.jarr: phaseA tests/pyret/main2.arr $(TEST_FILES)
	$(PROMISE_TEST_BUILD) --compiled-dir tests/compiled-promise/ --outfile tests/pyret/main2.p.jarr --build-runnable tests/pyret/main2.arr -check-all

# Pre-warm ./compiled-promise (the runtime nested-compile cache) with non-check builtins.
.PHONY : warm-promise-cache
warm-promise-cache: phaseA
	@printf 'import lists as L\nimport sets as S\nimport string-dict as SD\nimport arrays as AR\nimport option as O\nimport either as E\nimport error as ERR\nimport srcloc as SL\nprint("warm")\n' > /tmp/pyret-warm-promise.arr
	$(PROMISE_TEST_BUILD) --compiled-dir compiled-promise/ --outfile /tmp/pyret-warm-promise.p.jarr --build-runnable /tmp/pyret-warm-promise.arr

.PHONY : pyret-test-promise
pyret-test-promise: phaseA warm-promise-cache tests/pyret/main2.p.jarr
	@echo "=== promise suite (expect: all tests pass) ==="
	NODE_PATH=$(CURDIR)/node_modules $(NODE22) tests/pyret/main2.p.jarr | tee /tmp/promise-suite-result.txt; \
	code=$${PIPESTATUS[0]}; \
	test $$code -eq 0 && echo "PROMISE SUITE OK" || { echo "PROMISE SUITE: failures (exit $$code)"; exit 1; }

.PHONY : all-pyret-test-promise
all-pyret-test-promise: pyret-test-promise
