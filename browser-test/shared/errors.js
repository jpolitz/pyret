/*
 * errors.js -- distinguish the two failure kinds.
 *
 * Content failures use node:assert and surface as AssertionError ("the editor
 * rendered the wrong thing"). Everything else -- a setup step that couldn't be
 * carried out, a value that never rendered, the editor not reaching a usable
 * state -- throws ProceduralError ("the test couldn't be conducted"). Both fail
 * the test, but the error class tells you which at a glance.
 */
class ProceduralError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProceduralError";
  }
}

module.exports = { ProceduralError };
