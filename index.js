/**
 * Host half of the side-chat bundle.
 *
 * A side conversation must stay out of the way, yet run turns like any other
 * conversation: not a fork (forks attach to the parent's workspace and show the
 * inherited transcript), not archived (the archive gate rejects every model
 * step). It is a blank Session created on demand in the parent's directory and
 * reused, so one conversation owns at most one side chat. The Host creates it
 * on a route only the page's owner Principal reaches.
 *
 * The page asks for one over the shared Fetch channel the Web carrier already
 * owns, on a route that admits only an owner Principal.
 */
import { randomUUID } from 'node:crypto';

/** Exact route the page posts to; it lives on the shared `/api` channel. */
const OPEN_ROUTE = '/api/side-chat/open';

/** Maximum accepted request body: two short ids, nothing else. */
const MAX_BODY_BYTES = 4096;

/** Host services the route itself needs. */
export const inject = ['agents'];

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 * @returns the response the shared Fetch bridge forwards.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Read and validate the posted request body.
 * @param request - the buffered Fetch request.
 * @returns the parent session id, or `undefined` when the body is unusable.
 */
async function parentIdOf(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const parentSessionId = payload.parentSessionId;
  return typeof parentSessionId === 'string' && parentSessionId !== '' ? parentSessionId : undefined;
}

/**
 * Create the temporary side Session of one live conversation.
 * @param ctx - Host plugin context.
 * @param parentSessionId - conversation the side chat belongs to.
 * @returns the created session id.
 * @throws when the parent is not live or the session cannot be created.
 */
async function createSideSession(ctx, parentSessionId) {
  const parent = ctx.agents.get(parentSessionId);
  if (parent === undefined) throw new Error(`side-chat: parent session "${parentSessionId}" is not live`);
  const sessionId = `session-${randomUUID()}`;
  const selection = ctx.get('agentDefaultModel')?.currentSelection();
  const cwd = parent.session.header.cwd;
  const handle = await ctx.agents.create({
    sessionId,
    parentAgent: parent,
    // A normal Session on purpose: a delegation header (`origin: 'subagent'`)
    // hides the Session from the workspace list, but it also makes the Client
    // treat it as a subagent continuation — a read-only composer, prompt routing
    // through `remote.subagents`, and file parts rejected outright. Until the
    // platform splits "hidden" from "delegated", usability wins.
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
    },
    ...(selection === undefined ? {} : {
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      },
    }),
  });
  return handle.agent.session.header.id;
}

/**
 * Register the route that opens a side conversation.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: OPEN_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const parentSessionId = await parentIdOf(request);
        if (parentSessionId === undefined) return json(400, { error: 'parent-session-required' });
        try {
          return json(200, { sessionId: await createSideSession(ctx, parentSessionId) });
        } catch (error) {
          return json(409, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'side-chat: open route');
  });
}
