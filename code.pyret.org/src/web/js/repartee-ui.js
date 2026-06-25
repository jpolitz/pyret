/*
  repartee-ui.js — the Repartee notebook UI, transplanted onto CPO's real editor.

  Rather than re-derive CPO's editor behaviour, this stands on it: the definitions
  chunk IS CPO.editor (the real definitions CodeMirror beforePyret.js builds, with
  the full Pyret config — keyword bolding, indent, cursor, electric keys), and each
  interaction entry is made with CPO.makeEditor (the same factory). The resize
  divider, fonts, themes and chrome are CPO's. We transplant only the Repartee
  brain: the incremental-rerun engine (lang's repartee.ts, driven through its
  pull/stream API so rendering never races execution), editable past entries, and
  the dashed/striped "edited / outdated" invalidation cue.

  Everything runtime-shaped — the engine, the value/error/check renderers, and now
  the editor factory (defsCM / makeEntryEditor) and resize hook — comes through the
  `boot` object built in cpo-main-ts.js. See REPARTEE_BOOT there.
*/

(function () {
  'use strict';

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  // Merge keybindings into a CodeMirror's extraKeys (kept in options.extraKeys so
  // the mocha harness, which calls cm.options.extraKeys.Enter(cm), can find them).
  function addKeys(cm, keys) {
    var existing = cm.getOption('extraKeys') || {};
    cm.setOption('extraKeys', CodeMirror.normalizeKeyMap(Object.assign({}, existing, keys)));
  }

  function makeRepartee(boot) {
    var gf = boot.getField;
    var runner = boot.makeRunner();
    var seq = 0;
    // The toolbar's run-dropdown toggles this; run() compiles with type-checking
    // when set (the "Type-check and run" mode), like CPO's #select-tc-run.
    var typeCheckMode = false;

    if (!boot.defsCM || !boot.replContainer || !boot.makeEntryEditor) {
      console.error('repartee-ui: boot is missing the editor machinery (defsCM / replContainer / makeEntryEditor)');
      return;
    }

    // ---- chunk model --------------------------------------------------------
    function makeChunkRecord(id, kind) {
      return {
        id: id, kind: kind, cm: null, el: null, resultEl: null, railEl: null,
        lastRunSource: null, dirty: true, ran: false, locator: null,
      };
    }

    var defsChunk = makeChunkRecord('definitions://', 'definitions');
    var interactions = [];

    function roster() { return [defsChunk].concat(interactions); }

    function buildLocator(chunk) {
      if (!chunk.locator) {
        chunk.locator = boot.makeChunkLocator(chunk.id, function () { return chunk.cm.getValue(); }, chunk.kind);
      }
      return chunk.locator;
    }

    // ---- visual state -------------------------------------------------------
    // The left status rail: a coloured bar down the left of each entry showing
    // where evaluation is up-to-date (green), running (blue), edited/stale
    // (dotted amber/grey) or errored (dotted red) — the prototype's per-chat
    // status line. Driven by data-rpt-state on the entry's rail element (the
    // .echo-container wrap for interactions, the .rpt-defs-output block for the
    // definitions) and styled in repartee.css.
    function setRail(chunk, state) {
      if (chunk.railEl) { chunk.railEl.setAttribute('data-rpt-state', state); }
    }
    function setChunkState(chunk, state) {
      setRail(chunk, state);
      if (!chunk.el) { return; }
      chunk.el.classList.remove('is-clean', 'is-edited', 'is-running', 'is-error', 'is-stale');
      chunk.el.classList.add('is-' + state);
    }
    function setResultStale(chunk, stale) {
      if (chunk.resultEl) { chunk.resultEl.classList.toggle('rpt-stale', !!stale); }
    }
    function markEditedFrom(chunk) {
      var all = roster();
      var i = all.indexOf(chunk);
      if (i < 0) { return; }
      setChunkState(chunk, 'edited');
      setResultStale(chunk, true);
      for (var j = i + 1; j < all.length; j++) {
        // downstream entries keep their own class but their results are now stale
        setResultStale(all[j], true);
        setRail(all[j], 'stale');
      }
    }
    function onChunkEdit(chunk) {
      if (chunk.cm.getValue() !== chunk.lastRunSource) {
        chunk.dirty = true;
        markEditedFrom(chunk);
      }
    }
    // Remove an interaction entry. The engine treats the roster as authoritative,
    // so dropping the chunk from `interactions` (and the DOM) is enough — its
    // snapshot is GC'd by roster omission on the next run, which resumes from the
    // predecessor's end-state. Deleting changes the program for everything that
    // followed, so those results are marked stale + dirty to re-run on next Run.
    function deleteChunk(chunk) {
      if (runner.isRunning()) { return; }
      var idx = interactions.indexOf(chunk);
      if (idx < 0) { return; }
      if (chunk.railEl && chunk.railEl.parentNode) {
        chunk.railEl.parentNode.removeChild(chunk.railEl);
      }
      boot.documents.delete(chunk.id);
      interactions.splice(idx, 1);
      for (var j = idx; j < interactions.length; j++) {
        interactions[j].dirty = true;
        setResultStale(interactions[j], true);
        setRail(interactions[j], 'stale');
      }
    }

    // ---- run (drive the engine's pull/stream API) ---------------------------
    function computeStartIndex() {
      var all = roster();
      var start = all.length;
      for (var i = 0; i < all.length; i++) {
        if (all[i].dirty || !all[i].ran) { start = i; break; }
      }
      while (start > 0 && !runner.hasEndState(all[start - 1].id)) { start--; }
      return start;
    }

    // Each `await renderResult(...)` runs while the engine is PARKED at its yield,
    // so rendering (which re-enters the runtime) never overlaps execution, yet
    // results stream in chunk-by-chunk. See repartee.ts rerunStream.
    async function run(forced) {
      if (runner.isRunning()) { return; }
      var all = roster();
      var startIndex = forced ? 0 : computeStartIndex();
      if (startIndex >= all.length) { return; }

      var locs = all.map(buildLocator);
      var opts = typeCheckMode
        ? Object.assign({}, boot.compileOptions, { typeCheck: true })
        : boot.compileOptions;
      for (var k = startIndex; k < all.length; k++) {
        setChunkState(all[k], 'running');
        clear(all[k].resultEl);
        all[k].resultEl.appendChild(el('span', 'rpt-pending replOutput', 'running…'));
      }
      setBusy(true);
      try {
        for await (var step of runner.rerunStream(locs, startIndex, opts)) {
          await renderResult(all[step.index], step.entry);
        }
      } catch (e) {
        console.error('repartee: run stream', e);
      } finally {
        setBusy(false);
      }
    }

    // ---- result rendering (CPO renderers + binding names) -------------------
    function renderResult(chunk, entry) {
      if (entry.$name === 'prefix-skipped') { return Promise.resolve(); }
      if (entry.$name === 'not-reached') {
        setChunkState(chunk, 'stale');
        setResultStale(chunk, true);
        clear(chunk.resultEl);
        chunk.resultEl.appendChild(el('span', 'rpt-notreached replOutput', 'not reached — an earlier entry stopped the run'));
        return Promise.resolve();
      }
      if (entry.$name === 'thrown') {
        return finishError(chunk, function (n) { return boot.render.parseError(n, entry.error); });
      }
      if (entry.$name === 'left') {
        return finishError(chunk, function (n) { return boot.render.compileProblems(n, entry.v); });
      }
      if (entry.$name === 'right') {
        var v = entry.v;
        var rr = boot.getModuleResultResult(v);
        if (!boot.isSuccessResult(rr)) {
          var exn = rr.exn;
          return finishError(chunk, function (n) {
            return boot.render.runtimeError(n, (exn && exn.exn !== undefined) ? exn.exn : exn, (exn && exn.pyretStack) || []);
          });
        }
        return finishSuccess(chunk, v, rr.result);
      }
      return Promise.resolve();
    }

    function finishError(chunk, renderInto) {
      clear(chunk.resultEl);
      setResultStale(chunk, false);
      setChunkState(chunk, 'error');
      chunk.ran = false;
      var node = el('div', 'rpt-error cm-s-default');
      chunk.resultEl.appendChild(node);
      return Promise.resolve(renderInto(node)).catch(function (e) {
        node.appendChild(el('div', 'rpt-error-fallback', String(e)));
      });
    }

    function finishSuccess(chunk, moduleResultV, record) {
      clear(chunk.resultEl);
      setResultStale(chunk, false);
      setChunkState(chunk, 'clean');
      chunk.dirty = false;
      chunk.ran = true;
      chunk.lastRunSource = chunk.cm.getValue();

      var dvObj = gf(record, 'defined-values');
      var names = dvObj ? Object.keys(dvObj) : [];
      var answer = gf(record, 'answer');
      var hasAnswer = (answer !== boot.nothing && answer !== undefined);

      var chain = Promise.resolve();

      names.forEach(function (name) {
        chain = chain.then(function () {
          var row = el('div', 'rpt-output cm-s-default');
          row.appendChild(el('span', 'rpt-name', name));
          row.appendChild(el('span', 'rpt-eq', ' = '));
          var vnode = el('span', 'rpt-value');
          row.appendChild(vnode);
          chunk.resultEl.appendChild(row);
          return boot.render.value(vnode, dvObj[name]);
        });
      });

      if (hasAnswer) {
        chain = chain.then(function () {
          var row = el('div', 'rpt-output cm-s-default');
          var vnode = el('span', 'rpt-value');
          row.appendChild(vnode);
          chunk.resultEl.appendChild(row);
          return boot.render.value(vnode, answer);
        });
      }

      chain = chain.then(function () {
        var checksNode = el('div', 'rpt-checks');
        chunk.resultEl.appendChild(checksNode);
        return boot.render.checks(checksNode, moduleResultV).then(function () {
          if (!checksNode.firstChild) { checksNode.remove(); }
        });
      });

      return chain;
    }

    // ---- interactions: editable `>>>` entries + the live prompt -------------
    function addInteraction(text) {
      var chunk = makeChunkRecord('chunk://' + (++seq), 'interaction');
      // The wrap class must be EXACTLY "echo-container" (the mocha harness's
      // evalPyretNoError checks `class === "echo-container"`), so the is-* state
      // classes live on the inner .repl-echo (rpt-entry), not the wrap.
      var wrap = el('div', 'echo-container');
      var echo = el('span', 'repl-echo rpt-entry');
      var sign = el('span', 'repl-prompt-sign');
      sign.setAttribute('aria-label', 'REPL prompt');
      var cmMount = el('span', 'rpt-echo-cm');
      echo.appendChild(sign);
      echo.appendChild(cmMount);
      // Delete affordance (a faint × revealed on hover/focus of the entry).
      var del = el('button', 'rpt-delete', '×');
      del.type = 'button';
      del.title = 'Delete this interaction';
      del.setAttribute('aria-label', 'Delete this interaction');
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deleteChunk(chunk);
      });
      echo.appendChild(del);
      var resultEl = el('div', 'rpt-interaction-result');
      wrap.appendChild(echo);
      wrap.appendChild(resultEl);
      interactionsList.appendChild(wrap);

      chunk.el = echo; // is-* state on .repl-echo, keeping the wrap class exact
      chunk.resultEl = resultEl;
      chunk.railEl = wrap; // the status rail spans the whole entry (echo + result)
      setRail(chunk, 'edited'); // freshly added, not yet run
      // CPO.makeEditor does container.append(jQueryTextarea), so the container
      // must be a jQuery object (a raw element's native .append would stringify it).
      chunk.cm = boot.makeEntryEditor(window.$(cmMount)); // CPO.makeEditor — full config
      chunk.cm.setValue(text);
      addKeys(chunk.cm, { 'Ctrl-Enter': function () { run(false); }, 'Cmd-Enter': function () { run(false); } });
      chunk.cm.on('change', function () { onChunkEdit(chunk); });
      boot.documents.set(chunk.id, chunk.cm.getDoc());
      interactions.push(chunk);
      chunk.cm.refresh();
      return chunk;
    }

    function sendLivePrompt() {
      if (runner.isRunning()) { return; }
      var text = liveCM.getValue();
      if (text.trim() === '') { return; }
      addInteraction(text);
      liveCM.setValue('');
      liveCM.focus();
      run(false);
      scrollRepl();
    }

    function scrollRepl() {
      setTimeout(function () { replPane.scrollTop = replPane.scrollHeight; }, 0);
    }

    function setBusy(busy) {
      if (runButton) { runButton.disabled = !!busy; }
      // The mocha harness waits for #breakButton to be DISABLED to know a run
      // finished: enabled while running, disabled when idle (as CPO does).
      if (breakButton) { breakButton.disabled = !busy; }
      replPane.classList.toggle('rpt-busy', !!busy);
    }

    function refreshAll() {
      if (boot.defsCM) { boot.defsCM.refresh(); }
      if (liveCM) { liveCM.refresh(); }
      interactions.forEach(function (c) { if (c.cm) { c.cm.refresh(); } });
    }

    // ---- assemble -----------------------------------------------------------
    var runButton = document.getElementById('runButton');
    var breakButton = document.getElementById('breakButton');

    // Definitions: CPO.editor (already in .replMain). We only attach behaviour.
    defsChunk.cm = boot.defsCM;
    defsChunk.el = boot.defsEl || null;
    defsChunk.cm.on('change', function () { onChunkEdit(defsChunk); });
    addKeys(defsChunk.cm, { 'Ctrl-Enter': function () { run(true); }, 'Cmd-Enter': function () { run(true); } });
    boot.documents.set(defsChunk.id, defsChunk.cm.getDoc());
    // Make Run (button / Shift-Enter via CPO.RUN_CODE) run the engine from the top.
    if (typeof CPO !== 'undefined') { CPO.RUN_CODE = function () { run(true); }; }

    // Interactions: a CPO repl in #REPL. CPO puts all results in a single #output
    // container (the harness reads it): the definitions-output block is the first
    // child and interaction echoes append after; the live prompt is below.
    var replContainer = boot.replContainer;
    // Clear #REPL of the empty CPO repl widget, but PRESERVE the resize handle
    // (#handle) that editor.html provides as a child of #REPL.
    Array.prototype.slice.call(replContainer.children).forEach(function (c) {
      if (c.id !== 'handle') { replContainer.removeChild(c); }
    });
    var replPane = el('div', 'repl cm-s-default');
    var output = el('div');
    output.id = 'output';
    var defsOut = el('div', 'rpt-defs-output rpt-interaction-result');
    defsChunk.resultEl = defsOut;
    defsChunk.railEl = defsOut; // defs status rail = the defs-output block's left edge
    output.appendChild(defsOut);
    var interactionsList = output;
    var liveRow = el('div', 'prompt-container');
    var prompt = el('span', 'repl-prompt');
    var liveSign = el('span', 'repl-prompt-sign');
    liveSign.setAttribute('aria-label', 'REPL prompt');
    prompt.appendChild(liveSign);
    liveRow.appendChild(prompt);
    replPane.appendChild(output);
    replPane.appendChild(liveRow);
    replContainer.appendChild(replPane);

    // Live prompt: CPO.makeEditor, mounted in .repl-prompt (so the harness's
    // `.repl-prompt > .CodeMirror` selector finds it), with Enter → send.
    var liveCM = boot.makeEntryEditor(window.$(prompt));
    addKeys(liveCM, {
      'Enter': function () { sendLivePrompt(); },
      'Shift-Enter': function (cm) { cm.replaceSelection('\n'); },
      'Ctrl-Enter': function () { sendLivePrompt(); },
      'Cmd-Enter': function () { sendLivePrompt(); },
    });
    replPane.addEventListener('click', function (e) {
      if (e.target === replPane || e.target === interactionsList) { liveCM.focus(); }
    });

    // Wire the CPO toolbar buttons + CPO's resize divider.
    if (runButton) {
      runButton.disabled = false;
      runButton.addEventListener('click', function () { run(true); });
    }
    if (breakButton) {
      breakButton.disabled = true;
      breakButton.addEventListener('click', function () { if (boot.breakAll) { boot.breakAll(); } });
    }
    if (boot.setupResize) { boot.setupResize(refreshAll); }

    var loader = document.getElementById('loader');
    if (loader) { loader.style.display = 'none'; }

    // First paint. Like CPO, we do NOT auto-run on load — the user clicks Run.
    // (This also keeps #runButton enabled and clickable for the parity harness,
    // rather than transiently disabling it during an initial run.)
    setTimeout(function () { refreshAll(); }, 0);

    return {
      run: run,
      addInteraction: addInteraction,
      refresh: refreshAll,
      getDefinitions: function () { return defsChunk.cm.getValue(); },
      setDefinitions: function (s) { defsChunk.cm.setValue(s); },
      // Toolbar run-dropdown: switch between plain run and type-check-and-run.
      setTypeCheck: function (b) { typeCheckMode = !!b; },
      getTypeCheck: function () { return typeCheckMode; },
    };
  }

  window.makeRepartee = makeRepartee;
})();
