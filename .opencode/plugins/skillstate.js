// Local opencode harness for this repository: load the adapter from source so the
// plugin under test can never drift from adapters/opencode/plugin/skillstate.js.
// Users installing into their own project copy the adapter file instead — see
// adapters/opencode/README.md.
export { Skillstate } from '../../adapters/opencode/plugin/skillstate.js';
