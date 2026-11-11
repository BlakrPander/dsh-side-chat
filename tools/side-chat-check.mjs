#!/usr/bin/env node
// Headless smoke test for the side-chat Client half: loads the module through a
// fake ModuleLoader, applies it against a recording context, renders the
// selection surface, and opens the resource provider end to end.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const SRC = new URL('../client.js', import.meta.url);
const calls = [];
let factory;

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      calls.push(['load', definition.id]);
      factory = definition.factory;
    },
  },
};
globalThis.document = undefined;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
};

new Function('window', 'document', fs.readFileSync(SRC, 'utf8'))(globalThis.window, undefined);

assert.equal(typeof factory, 'function', 'module registered a factory');
assert.equal(calls[0][1], 'dsh-side-chat', 'module id equals the package name');

// --- minimal React stand-in -------------------------------------------------
const rendered = [];
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [initial, (next) => { rendered.push(['state', next]); }];
  },
  useEffect() {},
};

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

function findButtons(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (node.type === 'button') out.push(node);
  for (const child of node.children ?? []) findButtons(child, out);
  return out;
}

// --- recording Cordis-like context -----------------------------------------
const effects = [];
const tabTypes = [];
const resourceProviders = [];
const slotRegistrations = [];
const dicts = [];
const openResourceCalls = [];
const forkCalls = [];
const retainCalls = [];

const locale = {
  bind(ns) {
    assert.equal(ns, 'sideChat');
    return (key) => `t(${key})`;
  },
  register(ns, table) {
    dicts.push([ns, table]);
    return () => {};
  },
};

const forkedChildren = { 'parent-session-1': { removed: false, title: 'parent title' } };
const sessions = {
  list: { getSnapshot: () => ({ byId: forkedChildren }) },
  retain(target, options) {
    retainCalls.push([target, options]);
    return {
      ready: Promise.resolve(),
      release() { retainCalls.push(['release', target]); },
    };
  },
};

const inputShell = {
  quote: undefined,
  draft: undefined,
  actions: {
    insertQuote(text) { inputShell.quote = text; return true; },
    setDraft(text) { inputShell.draft = text; },
  },
};

function makeScope(deps) {
  const scope = {
    effect(fn) { effects.push(deps.join(',') + ':' + fn); const dispose = fn(); return () => { dispose?.(); }; },
    slots: {
      inject(key, callback) { return callback(); },
      register(options, component) { slotRegistrations.push([deps.join(','), options, component]); return () => {}; },
    },
    resources: {
      register(provider) { resourceProviders.push(provider); return () => {}; },
    },
    sidebarRightTabs: {
      register(definition) { tabTypes.push(definition); return () => {}; },
    },
    sessions,
    conversation: { input: { shell: () => inputShell } },
  };
  return scope;
}

const openCalls = [];
globalThis.__DSH_TRANSPORT__ = {
  async fetch(url, init) {
    openCalls.push([url, JSON.parse(init.body)]);
    const id = `side-session-${openCalls.length}`;
    forkedChildren[id] = { removed: false, title: 'parent title' };
    return new Response(JSON.stringify({ sessionId: id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};
const ctx = {
  locale,
  sessions,
  effect(fn) { effects.push(fn); const dispose = fn(); return () => { dispose?.(); }; },
  slots: {
    inject(key, callback) { return callback(); },
    register(options, component) { slotRegistrations.push(['root', options, component]); return () => {}; },
  },
  inject(deps, callback) { callback(makeScope(deps)); },
  get(name) {
    if (name === 'conversation') return { input: { shell: () => inputShell } };
    if (name === 'sidebarRight') {
      return { openResource(address) { openResourceCalls.push(address); } };
    }
    return undefined;
  },
};

const plugin = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'uiConversation']);
plugin.apply(ctx);

// --- assertions -------------------------------------------------------------
assert.equal(dicts.length, 1, 'registers one dictionary');
assert.equal(dicts[0][0], 'sideChat');
assert.deepEqual(Object.keys(dicts[0][1]).sort(), ['en', 'zh']);
const zhKeys = Object.keys(dicts[0][1].zh).sort();
assert.deepEqual(Object.keys(dicts[0][1].en).sort(), zhKeys, 'en and zh expose the same keys');

const surface = slotRegistrations.find(([, options]) => options.name === 'conversation.chat.text-interaction');
assert.ok(surface, 'registers the selection surface');
assert.equal(surface[1].key, 'quote');
assert.equal(surface[1].locale, 'sideChat');
assert.equal(surface[1].priority, -100, 'shadows the shipped pill at a lower priority');

assert.equal(tabTypes.length, 1, 'registers one tab type');
assert.equal(tabTypes[0].id, 'dsh-side-chat');
assert.equal(tabTypes[0].kind, 'sidechat');
assert.equal(tabTypes[0].priority, 'extension');
assert.equal(tabTypes[0].title('dsh-resource://sidechat/session/x'), 't(tab.title)');
assert.equal(tabTypes[0].canOpen('dsh-resource://sidechat/session/abc'), true);
assert.equal(tabTypes[0].canOpen('dsh-resource://file/abc'), false);
assert.equal(tabTypes[0].patterns[0], 'dsh-resource://sidechat/session/**');

assert.equal(resourceProviders.length, 1);
assert.equal(resourceProviders[0].protocol, 'sidechat');

const body = slotRegistrations.find(([, options]) => options.name === 'sidebar.right.pane.tab');
assert.ok(body, 'registers the tab body');
assert.equal(body[1].key, 'dsh-side-chat');
assert.deepEqual(body[1].children, { 'sidechat.seat': { kind: 'single', scope: 'session' } },
  'declares its own session seat without redeclaring the shipped chat seat');

// --- render the selection surface ------------------------------------------
const surfaceProps = {
  trigger: 'selection',
  dismiss() { surfaceProps.dismissed = true; },
  readText: () => 'picked text',
  clearSelection() {},
  inputActions: {
    insertQuote(text) { surfaceProps.quoted = text; return true; },
  },
  useSession: (selector) => selector({ removed: false, subagent: null }),
  sessionId: 'parent-session-1',
  t: (key) => `t(${key})`,
};
const tree = surface[2](surfaceProps);
const buttons = findButtons(tree);
assert.equal(buttons.length, 2, 'two actions in one surface');
assert.equal(textOf(buttons[0]), 't(quote.add)');
assert.equal(textOf(buttons[1]), 't(side.add)');

buttons[0].props.onClick();
assert.equal(surfaceProps.quoted, 'picked text', 'quote still quotes the selection');

// create through the Host route + open, as the side-chat button does
log('button label: ' + textOf(buttons[1]));
buttons[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(openCalls.length, 1, 'asks the Host once');
assert.equal(openCalls[0][0], '/api/side-chat/open');
assert.deepEqual(openCalls[0][1], { parentSessionId: 'parent-session-1' });
assert.deepEqual(openResourceCalls, ['dsh-resource://sidechat/session/side-session-1']);

// a second click reuses that side session instead of creating another
buttons[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(openCalls.length, 1, 'one temporary side session per conversation');
assert.deepEqual(openResourceCalls, [
  'dsh-resource://sidechat/session/side-session-1',
  'dsh-resource://sidechat/session/side-session-1',
]);

// --- open the provider ------------------------------------------------------
const controller = new AbortController();
const iterator = resourceProviders[0].open(openResourceCalls[0], { signal: controller.signal });
const first = await iterator.next();
assert.equal(first.done, false);
assert.equal(first.value.ok, true);
assert.equal(first.value.value.sessionId, 'side-session-1');
assert.deepEqual(retainCalls[0][0], 'side-session-1');
assert.equal(retainCalls[0][1].source, 'sideChat');
assert.equal(inputShell.quote, 'picked text', 'the side composer receives the selection as a quote');
assert.match(inputShell.draft, /^@\[parent title\]\(dsh-session:[A-Za-z0-9_-]+\)\n\n$/u,
  'the draft cites the parent conversation as a session reference');
controller.abort();
const end = await iterator.next();
assert.equal(end.done, true);
assert.deepEqual(retainCalls.at(-1), ['release', 'side-session-1'], 'the reference is released with the tab');

// --- tab body ---------------------------------------------------------------
const tabInfo = { tab: { contentId: openResourceCalls[0] } };
const SessionProvider = function Provider(props) { return props.children; };
const factoryCalls = [];
const sideTabProps = {
  useResource: () => ({ status: 'open', value: first.value.value }),
  useTabInfo: () => tabInfo,
  SessionProvider,
  renderFactorySlot: (name, owner, opts) => { factoryCalls.push([name, owner, opts]); return null; },
  t: (key) => `t(${key})`,
};
const tabTree = body[2](sideTabProps);
assert.equal(tabTree.type, 'div');
const providerNode = tabTree.children[0];
assert.equal(providerNode.type, SessionProvider);
assert.equal(providerNode.props.session, first.value.value.reference);
assert.equal(factoryCalls.length, 1);
assert.equal(factoryCalls[0][0], 'conversation.content');
assert.equal(factoryCalls[0][1].variant, 'embedded');
assert.equal(typeof factoryCalls[0][2].slots.views, 'function');
const viewProps = {
  renderSlot: (name, props) => [name, props],
};
assert.deepEqual(factoryCalls[0][2].slots.views(viewProps), ['conversation.session', { view: 'chat' }]);

// failed resource renders the localized failure
const failedTree = body[2]({
  useResource: () => ({ status: 'failed', value: undefined }),
  useTabInfo: () => tabInfo,
  SessionProvider,
  renderFactorySlot: () => null,
  t: (key) => `t(${key})`,
});
assert.equal(textOf(failedTree), 't(tab.failed)');

function log(message) { process.stdout.write(message + '\n'); }
log('side-chat client smoke test: ok');
