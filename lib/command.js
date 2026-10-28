'use strict';

// Whether the plugin should sync and inject by itself for this Hexo command.
// Only `generate` and `deploy` qualify (`hexo g -d`, `hexo d -g` included), and
// never in watch mode, where every save would trigger a new push. `hexo server`
// fires the same filters, so the command has to be checked, not the hook.
//
//   cmd      the command as typed (`g`, `generate`, ...)
//   args     the parsed command arguments (`w` / `watch` are the watch flags)
//   aliases  hexo.extend.console.alias, mapping short names to full names
function autoRunEnabled(input) {
  const options = input || {};
  const aliases = options.aliases || {};
  const cmd = options.cmd;

  let name = cmd;
  if (typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(aliases, cmd) && aliases[cmd]) {
    name = aliases[cmd];
  }
  if (name !== 'generate' && name !== 'deploy') return false;

  const args = options.args || {};
  return !args.w && !args.watch;
}

module.exports = { autoRunEnabled };
