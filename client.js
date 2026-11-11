window.__ModuleLoader__.load({
  id: '@local/side-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'sideChat';
    /** Resource protocol of one side-chat tab, the URL host of its address. */
    const PROTOCOL = 'sidechat';
    /** Right-Sidebar tab kind carrying a side conversation. */
    const KIND = 'sidechat';
    /** Tab-type identity, unique across every registration in the column. */
    const TAB_TYPE_ID = '@local/side-chat';
    /** Cell key this plugin occupies in the surface the Quote interaction opens. */
    const SURFACE_KEY = 'quote';
    /** Priority that shadows the shipped Quote pill; a keyed slot renders the lowest. */
    const SHADOW_PRIORITY = -100;
    const ADDRESS_PREFIX = `dsh-resource://${PROTOCOL}/session/`;
    const ADDRESS_PATTERN = /^dsh-resource:\/\/sidechat\/session\/([^/?#]+)/u;

    const zh = {
      'quote.add': '引用文本',
      'side.add': '侧栏会话',
      'side.pending': '正在新建…',
      'side.failed': '无法在侧栏开启会话：{message}',
      'side.empty': '请先选中一段文本。',
      'side.needsTurn': '先在这条会话里发一条消息，再来开侧栏会话。',
      'side.needsRestart': '宿主端还没加载新版本，重启一次应用即可。',
      'tab.title': '侧栏会话',
      'tab.loading': '正在打开侧栏会话…',
      'tab.failed': '无法打开这个侧栏会话。',
      'tab.unavailable': '侧栏会话需要同时启用会话与右侧栏插件。',
    };
    const en = {
      'quote.add': 'Quote text',
      'side.add': 'Side chat',
      'side.pending': 'Opening…',
      'side.failed': 'Could not open a side chat: {message}',
      'side.empty': 'Select some text first.',
      'side.needsTurn': 'Send a message in this conversation first, then open a side chat.',
      'side.needsRestart': 'The host half is not loaded yet; restart the app once.',
      'tab.title': 'Side chat',
      'tab.loading': 'Opening the side chat…',
      'tab.failed': 'This side chat could not be opened.',
      'tab.unavailable': 'Side chat needs the conversation and right-sidebar plugins.',
    };

    const styles = {
      row: 'sc_row',
      action: 'sc_action',
      error: 'sc_error',
      root: 'sc_root',
      note: 'sc_note',
    };

    const CSS = [
      '.sc_row{display:flex;align-items:center;gap:6px;max-width:min(420px,80vw)}',
      '.sc_action{corner-shape:round;background:var(--dsw-alias-button-floating-fill);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);',
      'color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;border:none;',
      'border-radius:999px;padding:5px 10px;white-space:nowrap}',
      '.sc_action:focus-visible{background:var(--dsw-alias-button-floating-hover)}',
      '.sc_action:disabled{cursor:default;opacity:.6}',
      '@media (hover:hover){.sc_action:not(:disabled):hover{background:var(--dsw-alias-button-floating-hover)}}',
      '.sc_error{font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis}',
      '.sc_root{width:100%;min-width:0;height:100%;min-height:0;display:flex}',
      '.sc_note{padding:20px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** Text a freshly created side session should show as its draft, keyed by session id. */
    const pendingDrafts = new Map();

    /** Services captured from the activation scope, used by the click path. */
    const services = { sidebarRight: undefined, conversation: undefined, sessions: undefined };

    /** Parent conversation each created side Session belongs to, for prefill. */
    const sideParents = new Map();

    /**
     * Encode one session id as the canonical reference URI the Host parses.
     * @param sessionId - opaque session id.
     * @returns base64url payload of the JSON-encoded id.
     */
    function sessionReferenceUri(sessionId) {
      const bytes = new TextEncoder().encode(JSON.stringify(String(sessionId)));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    }

    /**
     * Render the Markdown mention that cites one conversation as context.
     * @param parentSessionId - the citing parent session.
     * @returns one `@[label](dsh-session:...)` line.
     */
    function sessionMentionOf(parentSessionId) {
      const list = services.sessions?.list.getSnapshot();
      const raw = list?.byId?.[String(parentSessionId)]?.title;
      const label = String(raw === undefined || raw === '' ? parentSessionId : raw)
        .replace(/[\\[\]]/gu, ' ')
        .trim()
        .slice(0, 80);
      return `@[${label || String(parentSessionId)}](dsh-session:${sessionReferenceUri(parentSessionId)})`;
    }

    /**
     * Ask the Host to create the temporary side Session.
     * @param parentSessionId - conversation the side chat belongs to.
     * @returns the created session id.
     */
    async function requestSideSession(parentSessionId) {
      const transport = globalThis.__DSH_TRANSPORT__;
      const send = typeof transport?.fetch === 'function'
        ? transport.fetch
        : (globalThis.fetch?.bind(globalThis) ?? undefined);
      if (send === undefined) throw new Error('side-chat: this page has no HTTP transport');
      const response = await send(OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentSessionId: String(parentSessionId) }),
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        // A 404 means this page still runs the previous Host half.
        if (response.status === 404) throw new Error(t('side.needsRestart'));
        const reason = payload !== undefined && typeof payload.error === 'string' ? payload.error : String(response.status);
        throw new Error(reason);
      }
      if (payload === undefined || typeof payload.sessionId !== 'string') {
        throw new Error('side-chat: the Host returned no session id');
      }
      sideParents.set(payload.sessionId, String(parentSessionId));
      return payload.sessionId;
    }

    /**
     * Whether one session is known to the page's session catalog.
     * @param sessions - the sessions service.
     * @param sessionId - candidate id.
     * @returns true when the snapshot carries it.
     */
    function stillListed(sessions, sessionId) {
      const entry = sessions.list.getSnapshot().byId[sessionId];
      return entry !== undefined && entry.removed !== true;
    }

    /**
     * Wait for the Host announcement of a session the page just created.
     * @param sessions - the sessions service.
     * @param sessionId - awaited id.
     * @returns resolves once the catalog carries it.
     */
    async function waitForListed(sessions, sessionId) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (stillListed(sessions, sessionId)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    /**
     * Resolve which parent a side session was created for.
     * @param sideSessionId - the side session.
     * @returns its parent session id, or the empty string when unknown.
     */
    function parentSessionIdOf(sideSessionId) {
      const direct = sideParents.get(sideSessionId);
      if (direct !== undefined) return direct;
      for (const [parent, child] of Object.entries(readPairs())) {
        if (child === sideSessionId) return parent;
      }
      return '';
    }

    /** Parent conversation id -> the one temporary side session serving it. */
    const PAIRS_KEY = 'side-chat.v3.side-sessions';

    /** Host route that creates one temporary side Session. */
    const OPEN_ROUTE = '/api/side-chat/open';

    function readPairs() {
      try {
        const raw = globalThis.localStorage?.getItem(PAIRS_KEY);
        const parsed = raw === undefined || raw === null ? {} : JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    }

    function writePairs(pairs) {
      try {
        globalThis.localStorage?.setItem(PAIRS_KEY, JSON.stringify(pairs));
      } catch {
        /* A private-mode storage failure only costs reuse across reloads. */
      }
    }

    function addressOf(sessionId) {
      return `${ADDRESS_PREFIX}${encodeURIComponent(String(sessionId))}`;
    }

    function sessionIdOfAddress(address) {
      if (typeof address !== 'string') return undefined;
      const match = ADDRESS_PATTERN.exec(address);
      if (match === null) return undefined;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return undefined;
      }
    }

    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
    }

    /**
     * Report one contribution failure to the page console, where the desktop's
     * boot diagnostic collects renderer errors.
     * @param what - the contribution that failed.
     * @param error - the thrown value.
     */
    function report(what, error) {
      try {
        console.error(`[side-chat] ${what} failed:`, (error && error.stack) || String(error));
      } catch {
        /* Reporting must never mask the original failure. */
      }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function format(template, message) {
      return template.replace('{message}', message);
    }

    function installStyles() {
      const tagId = `${TAB_TYPE_ID}/side-chat.css`;
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) {
        return () => {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = TAB_TYPE_ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    /**
     * Run the Client body and report the real reason before Cordis only records a
     * failed fiber (the boot audit prints the state, not the error).
     * @param ctx - Client plugin context.
     */
    function activate(ctx) {
        const t = ctx.locale.bind(NS);

        /**
         * Put selected text into a side session's composer as a quote, so the
         * conversation opens on the passage it was started from.
         * @param sideSessionId - the side session whose composer receives it.
         * @param text - selected text, already dedented by the caller.
         */
        const prefill = (parentSessionId, sideSessionId, text) => {
          try {
            const conversation = services.conversation ?? ctx.get('conversation');
            const shell = conversation?.input?.shell?.(sideSessionId);
            if (shell === undefined) return;
            const normalized = text.replace(/\r\n?/gu, '\n');
            // The parent conversation travels as a session reference, so the model
            // reads it while the side chat itself starts blank.
            const mention = parentSessionId === '' ? '' : `${sessionMentionOf(parentSessionId)}\n\n`;
            try {
              shell.actions.setDraft(mention);
              if (shell.actions.insertQuote(normalized)) return;
            } catch {
              /* Fall through to a plain draft. */
            }
            shell.actions.setDraft(`${mention}> ${normalized.split('\n').join('\n> ')}\n\n`);
          } catch {
            /* The side conversation still opens with an empty composer. */
          }
        };

        /**
         * Resolve the temporary side session of one conversation, creating it once.
         * The Host owns creation so the Session carries a delegation header: the
         * workspace list filters those out, while the session still runs turns.
         * @param parentSessionId - the conversation the selection came from.
         * @returns the side session id.
         */
        const ensureSideSession = async (parentSessionId) => {
          const sessions = services.sessions ?? ctx.sessions;
          const pairs = readPairs();
          const key = String(parentSessionId);
          const known = pairs[key];
          if (known !== undefined && stillListed(sessions, String(known))) return String(known);
          const created = await requestSideSession(parentSessionId);
          pairs[key] = created;
          writePairs(pairs);
          await waitForListed(sessions, created);
          return created;
        };

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries');
        ctx.effect(() => installStyles(), 'side-chat: styles');

        /** Two pills inside the surface the Quote interaction already opens. */
        function SelectionActions(props) {
          const { dismiss, readText, clearSelection, inputActions, useSession, sessionId } = props;
          const [busy, setBusy] = useState(false);
          const [error, setError] = useState(null);
          const blank = useSession((s) => s.blank === true);
          const enabled = useSession((s) => !s.removed && (s.subagent === null
            || (s.subagent.address.mode === 'continuable' && s.subagent.parentAvailable === true)));
          useEffect(() => {
            if (!enabled) dismiss();
          }, [enabled, dismiss]);
          if (!enabled) return null;

          const quote = () => {
            const text = readText();
            if (text === null) {
              dismiss();
              return;
            }
            if (!inputActions.insertQuote(text)) return;
            clearSelection();
            dismiss();
          };

          const openSideChat = async () => {
            const text = readText();
            if (text === null || text.trim() === '') {
              dismiss();
              return;
            }
            if (blank) {
              setError(t('side.needsTurn'));
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const sideSessionId = await ensureSideSession(sessionId);
              pendingDrafts.set(String(sideSessionId), text);
              const sidebarRight = services.sidebarRight ?? ctx.get('sidebarRight');
              if (sidebarRight === undefined) throw new Error(t('tab.unavailable'));
              sidebarRight.openResource(addressOf(sideSessionId));
              clearSelection();
              dismiss();
            } catch (failure) {
              setError(format(t('side.failed'), messageOf(failure)));
              setBusy(false);
            }
          };

          return h('div', { className: styles.row },
            h('button', {
              type: 'button',
              className: styles.action,
              'aria-label': t('quote.add'),
              onPointerDown: (event) => { event.preventDefault(); },
              onClick: quote,
            }, t('quote.add')),
            h('button', {
              type: 'button',
              className: styles.action,
              'aria-label': t('side.add'),
              disabled: busy,
              onPointerDown: (event) => { event.preventDefault(); },
              onClick: () => { void openSideChat(); },
            }, busy ? t('side.pending') : t('side.add')),
            error === null ? null : h('span', { className: styles.error, role: 'status' }, error));
        }

        // The Quote plugin already owns this cell at priority 0, and a keyed slot
        // rejects a second entry at the same priority; the lowest priority renders.
        ctx.slots.inject('conversation.chat.text-interaction', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.chat.text-interaction',
              key: SURFACE_KEY,
              priority: SHADOW_PRIORITY,
              locale: NS,
            }, SelectionActions);
          } catch (error) {
            report('surface registration', error);
            throw error;
          }
        });

        ctx.inject(['resources', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'conversation'], (scope) => {
          const sessions = scope.sessions;
          services.sessions = sessions;
          services.sidebarRight = scope.sidebarRight;
          services.conversation = scope.conversation;

          /** One retained Session reference per open side-chat tab. */
          const provider = {
            protocol: PROTOCOL,
            async *open(resourceAddress, { signal }) {
              const sideSessionId = sessionIdOfAddress(resourceAddress);
              if (sideSessionId === undefined) {
                yield { ok: false, error: new Error(`side-chat: not a side-chat address: ${resourceAddress}`) };
                return;
              }
              let reference;
              try {
                reference = sessions.retain(sideSessionId, { source: 'sideChat', signal });
              } catch (failure) {
                yield { ok: false, error: failure };
                return;
              }
              try {
                await reference.ready;
                if (signal.aborted) return;
                const draft = pendingDrafts.get(sideSessionId);
                if (draft !== undefined) {
                  pendingDrafts.delete(sideSessionId);
                  prefill(parentSessionIdOf(sideSessionId), sideSessionId, draft);
                }
                yield { ok: true, value: { reference, sessionId: sideSessionId } };
                await waitForAbort(signal);
              } catch (failure) {
                yield { ok: false, error: failure };
              } finally {
                reference.release();
              }
            },
          };

          /**
           * The one Conversation view this tab hosts: it reads the binding the
           * embedded factory put in scope and renders the shipped chat body.
           * @param props - the factory's view seat.
           * @returns the Chat view of the side session.
           */
          function SideChatView(props) {
            return props.renderSlot('conversation.session', { view: 'chat' });
          }

          /**
           * The tab body: bind the side session, then host the shipped Conversation
           * factory against that binding.
           * @param props - right-Sidebar tab seat.
           * @returns the embedded conversation, or the reason it could not mount.
           */
          function SideChatTab(props) {
            const { useResource, useTabInfo, SessionProvider, renderFactorySlot } = props;
            const { tab } = useTabInfo();
            const resource = useResource(tab.contentId);
            const value = resource === undefined ? undefined : resource.value;
            if (value === undefined) {
              const failed = resource !== undefined && resource.status === 'failed';
              return h('div', { className: styles.root },
                h('div', { className: styles.note }, failed ? t('tab.failed') : t('tab.loading')));
            }
            if (SessionProvider === undefined || renderFactorySlot === undefined) {
              return h('div', { className: styles.root },
                h('div', { className: styles.note },
                  `${t('tab.unavailable')} (SessionProvider=${typeof SessionProvider} renderFactorySlot=${typeof renderFactorySlot})`));
            }
            try {
              return h('div', { className: styles.root },
                h(SessionProvider, { session: value.reference },
                  renderFactorySlot('conversation.content', {
                    variant: 'embedded',
                    phase: 'active',
                    hero: false,
                  }, { slots: { views: SideChatView } })));
            } catch (error) {
              report('tab mount', error);
              return h('div', { className: styles.root },
                h('div', { className: styles.note }, `${t('tab.unavailable')} (${messageOf(error)})`));
            }
          }

          scope.effect(() => scope.resources.register(provider), 'side-chat: side-chat resource');
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_TYPE_ID,
            kind: KIND,
            patterns: [`${ADDRESS_PREFIX}**`],
            priority: 'extension',
            canOpen: (address) => sessionIdOfAddress(address) !== undefined,
            title: () => t('tab.title'),
          }), 'side-chat: right-sidebar tab type');
          // A body that hosts a Session receives SessionProvider only when it declares
          // a non-root child seat; the Conversation factory itself is reached through
          // renderFactorySlot, which needs no declaration.
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => {
            try {
              return scope.slots.register({
                name: 'sidebar.right.pane.tab',
                key: TAB_TYPE_ID,
                children: { 'sidechat.seat': { kind: 'single', scope: 'session' } },
              }, SideChatTab);
            } catch (error) {
              report('tab body registration', error);
              throw error;
            }
          }), 'side-chat: right-sidebar tab body');
        });
    }

    return {
      name: 'side-chat',
      inject: ['slots', 'locale', 'sessions', 'uiConversation'],
      apply(ctx) {
        try {
          activate(ctx);
        } catch (error) {
          report('activation', error);
          throw error;
        }
      },
    };
  },
});
