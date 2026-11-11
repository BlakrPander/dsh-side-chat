#!/usr/bin/env node
// Run the side-chat Client half against the real Cordis runtime with fake Harness
// services, to surface activation errors that the browser boot only reports as
// "<plugin>: failed".
import fs from 'node:fs';

// Point CORDIS_PATH at an extracted @deepseek-ai/cordis/lib/index.js, for example
// the copy inside the DSH app bundle:
//   CORDIS_PATH=/path/to/node_modules/@deepseek-ai/cordis/lib/index.js node tools/side-chat-apply.mjs
const CORDIS_PATH = process.env.CORDIS_PATH;
if (CORDIS_PATH === undefined || CORDIS_PATH === '') {
  console.error('side-chat-apply: set CORDIS_PATH to an extracted @deepseek-ai/cordis/lib/index.js');
  process.exit(2);
}
const { Context } = await import(CORDIS_PATH);

const SRC = new URL('../client.js', import.meta.url);
const mode = process.argv[2] ?? 'deferred'; // 'deferred' | 'declared'

let factory;
globalThis.window = { __ModuleLoader__: { load(definition) { factory = definition.factory; } } };
new Function('window', fs.readFileSync(SRC, 'utf8'))(globalThis.window);

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};
const plugin = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

const root = new Context();

const log = (...args) => console.log('[harness]', ...args);
let throwOnRegister = null;

// SlotCore's real rules: a slot must be declared by a parent children table,
// a keyed cell rejects a second entry at the same priority, and a slot name may
// be declared only once.
const declared = new Map([
  ['conversation.chat.text-interaction', { kind: 'keyed', declaredBy: 'an entry in "conversation.view" (client-ui-chat)' }],
  ['sidebar.right.pane.tab', { kind: 'keyed', declaredBy: 'an entry in "rightbar.session"' }],
  ['sidebar.chat.conversation', { kind: 'single', declaredBy: 'an entry in "sidebar.right.pane.tab" (client-ui-subagent)' }],
]);
const cellEntries = [{ options: { key: 'quote', priority: 0 }, registrant: 'message-quotes' }];

const slots = {
  inject(key, callback) {
    if (declared.has(key)) {
      // Real SlotRegistry runs the callback synchronously when the slot exists.
      return callback();
    }
    // Not declared yet: the real one registers a wait and runs the callback later.
    return () => log('slot wait disposed for', key);
  },
  register(options, component) {
    if (throwOnRegister !== null) throw throwOnRegister;
    const spec = declared.get(options.name);
    if (spec === undefined) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
    const priority = options.priority ?? 0;
    const holder = cellEntries.find((entry) => entry.options.key === options.key && (entry.options.priority ?? 0) === priority);
    if (spec.kind === 'keyed' && holder !== undefined) {
      throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}" at priority ${priority} (registered by ${holder.registrant}) — register at a different priority to shadow it (lowest renders)`);
    }
    for (const child of Object.keys(options.children ?? {})) {
      if (declared.has(child)) throw new Error(`slot "${child}" is already declared (by ${declared.get(child).declaredBy})`);
    }
    if (spec.kind === 'keyed' && options.key !== undefined) cellEntries.push({ options: { key: options.key, priority }, registrant: plugin.name ?? 'plugin' });
    for (const child of Object.keys(options.children ?? {})) declared.set(child, { kind: 'single', declaredBy: `an entry in "${options.name}"` });
    log('slots.register', JSON.stringify(options));
    return () => log('slot registration disposed', options.key ?? options.id);
  },
};

const locale = {
  bind(ns) { log('locale.bind', ns); return (key) => `${ns}:${key}`; },
  register(ns, dicts) { log('locale.register', ns, Object.keys(dicts ?? {}).join(',')); return () => {}; },
};

const sessions = {
  async fork(options) { log('sessions.fork', JSON.stringify(options)); return 'child'; },
  retain(target, options) { log('sessions.retain', target, JSON.stringify(options)); return { ready: Promise.resolve(), release() {} }; },
  list: { getSnapshot: () => ({ byId: {} }) },
  binding: () => undefined,
};

const resources = { register: (provider) => { log('resources.register', provider.protocol); return () => {}; } };
const sidebarRightTabs = { register: (def) => { log('sidebarRightTabs.register', def.id, def.kind); return () => {}; } };
const sidebarRight = { openResource: (a) => log('openResource', a) };
const conversation = { input: { shell: () => undefined } };
const uiConversation = { interactions: { register: () => () => {} }, userText: { register: () => () => {} } };

for (const [name, value] of Object.entries({
  slots, locale, sessions, uiConversation, resources, sidebarRightTabs, sidebarRight, conversation,
})) {
  root.provide(name, value);
}

const fiber = root.plugin(plugin);
try {
  await fiber;
  log('fiber settled:', fiber.state);
  console.log('APPLY OK (' + mode + ')');
} catch (error) {
  console.error('APPLY FAILED (' + mode + '):', error?.message);
  console.error(error?.stack);
  process.exitCode = 1;
}
