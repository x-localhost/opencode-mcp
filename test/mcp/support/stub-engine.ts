// A scripted fake Engine for the MCP integration tests (test/mcp/**). Not itself a *.test.ts
// file, so `npm test`'s glob does not try to run it directly; it is imported by
// test/mcp/fixtures/stub-server.ts, which is spawned as a real child process.
//
// Behaviour is scripted through `prompt` (JSON-encoded) so the whole test stays on the wire:
// a raw JSON-RPC test client drives everything through tool calls, including reading back the
// recorded call log via `opencode-status` with no id (its `content` is `JSON.stringify(calls)`).

import type {
  ApprovalDecision,
  ApprovalRequest,
  BatchItem,
  BatchResult,
  BatchStatusInput,
  CallContext,
  EndAction,
  EndResult,
  Engine,
  EngineErrorCode,
  InfoInput,
  InfoResult,
  ListResult,
  OutputInput,
  OutputResult,
  OutputToolCall,
  ReplyInput,
  StartInput,
  TurnResult,
} from '../../../src/types.ts';
import { EngineError } from '../../../src/types.ts';

export type RecordedTool =
  | 'start'
  | 'reply'
  | 'status'
  | 'cancel'
  | 'end'
  | 'list'
  | 'shutdown'
  | 'aborted'
  | 'output'
  | 'info'
  | 'statusMany';

export interface RecordedCall {
  tool: RecordedTool;
  args: unknown;
}

/** What engine.output() (and now status()/statusMany()) replay for one committed turn (F8 stub:
 * enough for wiring-level tests; the deep presentation/fitting behaviour is unit-tested directly
 * against src/mcp/format.ts). */
interface TurnRecord {
  content: string;
  toolCalls: OutputToolCall[];
  filesChanged: string[];
}

interface SessionState {
  id: string;
  turn: number;
  pendingCancel?: () => void;
  turns: Map<number, TurnRecord>;
  /** v0.3 §1: consumed (and cleared) by the next engine.output() call for this session, so a test
   * can force one specific error code/message without a second scripting channel. */
  nextOutputError?: { code: EngineErrorCode; message: string };
  /** A10: consumed (and cleared) by the next engine.output() call for a diff/patch section, so a
   * test can prove src/mcp/tools.ts derives isError from the FINAL formatted envelope. Every real
   * identifier a client can supply is schema-bounded to <=200 chars (nowhere near format.ts's
   * 45000-char HARD_BUDGET), so format.ts's own last-resort "even one item does not fit"
   * (formatOutputResult -> buildOutputTooLargeError) envelope substitution is otherwise
   * unreachable through the real MCP surface — this stands in for a field a future engine change
   * might leave unbounded, without needing to violate OutputResult's own type contract. */
  nextOutputHugeSnapshotIdChars?: number;
}

export type Script =
  | {
      mode: 'immediate';
      content?: string;
      status?: TurnResult['status'];
      /** v0.3 (F8): lets a test drive any new TurnResult field (output, structuredOutputStatus,
       * structuredOutput, structuredOutputError, request, toolCalls, filesChanged,
       * pendingApprovals, …) without a dedicated Script variant per field. */
      overrides?: Partial<TurnResult>;
      /** Primes session.nextOutputError, consumed by the next engine.output() call. */
      nextOutputError?: { code: EngineErrorCode; message: string };
      /** Primes session.nextOutputHugeSnapshotIdChars, consumed by the next engine.output() call
       * for section:"diff", diff-view:"patch" (A10). */
      nextOutputHugeSnapshotIdChars?: number;
    }
  | { mode: 'progress'; messages: string[]; intervalMs?: number; content?: string }
  /** Resolves only when the owning call's AbortSignal fires (a JSON-RPC notifications/cancelled). */
  | { mode: 'hang-signal' }
  /** Resolves only when a later engine.cancel() call for the same session releases it. */
  | { mode: 'hang-cancel' }
  | { mode: 'elicit'; permission: string; patterns: string[] }
  // overload design §B: `retryAfterSeconds` (when given) is attached as a duck-typed own-property
  // on the thrown EngineError (src/mcp/tools.ts's retryAfterSecondsFrom), the same way a future
  // engine-side OPENCODE_OVERLOADED mapping could attach one without any src/types.ts change.
  | { mode: 'throw-engine-error'; code: EngineErrorCode; message: string; retryAfterSeconds?: number }
  | { mode: 'throw-unexpected' }
  /** U01: exercises ctx.setSessionId, the way engine.start does right after registry.add. */
  | { mode: 'set-session-id'; messages: string[]; intervalMs?: number }
  /** U15 (r2-r-tests-3): returns a snapshot immediately like 'immediate', but never detaches from
   * ctx.signal, so a test can prove a stale notifications/cancelled for this already-returned call
   * never fires it — not through any diligence of this stub. (Verified: with the current SDK, the
   * guarantee actually lives one layer below src/mcp/tools.ts, in the SDK's own per-request
   * AbortController bookkeeping — see the test file for the caveat.) */
  | { mode: 'immediate-recorder'; content?: string; status?: TurnResult['status'] };

function parseScript(prompt: string): Script {
  try {
    const parsed: unknown = JSON.parse(prompt);
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { mode?: unknown }).mode === 'string') {
      return parsed as Script;
    }
  } catch {
    // not JSON: fall through to a plain echo
  }
  return { mode: 'immediate', content: `echo: ${prompt}` };
}

// Never left pending forever even if a test forgets to release a hang-* session.
const SAFETY_NET_MS = 20_000;

export interface StubEngine extends Engine {
  readonly calls: RecordedCall[];
  readonly shutdownCallCount: number;
}

export function createStubEngine(): StubEngine {
  let counter = 0;
  let shutdownCallCount = 0;
  const sessions = new Map<string, SessionState>();
  const calls: RecordedCall[] = [];

  function snapshot(session: SessionState, overrides: Partial<TurnResult>): TurnResult {
    return {
      kind: 'turn',
      threadId: session.id,
      sessionId: session.id,
      turnId: `${session.id}#${session.turn}`,
      turn: session.turn,
      status: 'completed',
      executionState: 'stopped',
      cleanup: 'complete',
      content: '',
      directory: '/stub',
      filesChanged: [],
      toolCalls: [],
      toolCallCount: 0,
      pendingApprovals: [],
      elapsedMs: 1,
      truncated: false,
      hint: 'use opencode-reply to continue',
      ...overrides,
    };
  }

  async function runScript(session: SessionState, script: Script, ctx: CallContext): Promise<TurnResult> {
    if (script.mode === 'immediate') {
      if (script.nextOutputError) session.nextOutputError = script.nextOutputError;
      if (script.nextOutputHugeSnapshotIdChars) session.nextOutputHugeSnapshotIdChars = script.nextOutputHugeSnapshotIdChars;
      return snapshot(session, {
        content: script.content ?? '',
        status: script.status ?? 'completed',
        ...script.overrides,
      });
    }
    if (script.mode === 'progress') {
      const interval = script.intervalMs ?? 5;
      for (const message of script.messages) {
        ctx.progress?.(message);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      return snapshot(session, { content: script.content ?? 'progressed', status: 'completed' });
    }
    if (script.mode === 'hang-signal') {
      return await new Promise<TurnResult>((resolve) => {
        // MCP spec: the server must not respond to a cancelled request, so the eventual
        // resolution here is not expected to reach the client. Record the abort into the call
        // log instead, so tests can observe it via a *different*, uncancelled request.
        const finish = () => {
          calls.push({ tool: 'aborted', args: { sessionId: session.id } });
          resolve(snapshot(session, { status: 'cancelled', content: 'aborted-by-signal' }));
        };
        if (ctx.signal.aborted) {
          finish();
          return;
        }
        ctx.signal.addEventListener('abort', finish, { once: true });
        const timer = setTimeout(
          () => resolve(snapshot(session, { status: 'timeout', content: 'safety-net-timeout' })),
          SAFETY_NET_MS,
        );
        timer.unref?.();
      });
    }
    if (script.mode === 'hang-cancel') {
      return await new Promise<TurnResult>((resolve) => {
        session.pendingCancel = () => resolve(snapshot(session, { status: 'cancelled', content: 'aborted-by-cancel' }));
        const timer = setTimeout(
          () => resolve(snapshot(session, { status: 'timeout', content: 'safety-net-timeout' })),
          SAFETY_NET_MS,
        );
        timer.unref?.();
      });
    }
    if (script.mode === 'elicit') {
      const req: ApprovalRequest = {
        requestId: `perm_${session.id}_${session.turn}`,
        sessionId: session.id,
        turnId: `${session.id}#${session.turn}`,
        permission: script.permission,
        patterns: script.patterns,
        metadata: {},
      };
      const decision: ApprovalDecision | null = ctx.elicit ? await ctx.elicit(req, ctx.signal) : null;
      const content = decision ? `decision:${decision.decision}:${decision.feedback ?? ''}` : 'decision:null';
      return snapshot(session, { content, status: 'completed' });
    }
    if (script.mode === 'immediate-recorder') {
      // Deliberately never removed: this mode exists to prove a stale cancellation for this
      // returned call never fires, regardless of any diligence on the engine's part.
      ctx.signal.addEventListener('abort', () => {
        calls.push({ tool: 'aborted', args: { sessionId: session.id } });
      });
      return snapshot(session, { content: script.content ?? '', status: script.status ?? 'completed' });
    }
    if (script.mode === 'throw-engine-error') {
      const err = new EngineError(script.code, script.message, session.id);
      if (script.retryAfterSeconds !== undefined) {
        Object.assign(err, { retryAfterSeconds: script.retryAfterSeconds });
      }
      throw err;
    }
    if (script.mode === 'set-session-id') {
      ctx.setSessionId?.('ses_x');
      const interval = script.intervalMs ?? 5;
      for (const message of script.messages) {
        ctx.progress?.(message);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      return snapshot(session, { content: 'session-id-set', status: 'completed' });
    }
    // 'throw-unexpected'
    throw new Error('unexpected stub failure');
  }

  function requireSession(sessionId: string): SessionState {
    const session = sessions.get(sessionId);
    if (!session) throw new EngineError('SESSION_NOT_FOUND', `no such session: ${sessionId}`, sessionId);
    return session;
  }

  /** Captures (content, toolCalls, filesChanged) for whatever turn a start/reply call just
   * produced, keyed by turn number, so engine.output()/status()/statusMany() can replay it later
   * — regardless of which Script mode ran. */
  function recordTurn(session: SessionState, result: TurnResult): void {
    session.turns.set(result.turn, {
      content: result.content,
      toolCalls: (result.toolCalls ?? []).map((tc, i) => ({
        messageId: `msg_${session.id}_${result.turn}_${i}`,
        callId: `call_${i}`,
        tool: tc.tool,
        status: tc.status,
        title: tc.title,
      })),
      filesChanged: result.filesChanged ?? [],
    });
  }

  return {
    calls,
    get shutdownCallCount() {
      return shutdownCallCount;
    },

    async start(input: StartInput, ctx: CallContext): Promise<TurnResult> {
      counter += 1;
      const session: SessionState = { id: `ses_${counter}`, turn: 1, turns: new Map() };
      sessions.set(session.id, session);
      calls.push({ tool: 'start', args: input });
      const result = await runScript(session, parseScript(input.prompt), ctx);
      recordTurn(session, result);
      return result;
    },

    async reply(input: ReplyInput, ctx: CallContext): Promise<TurnResult> {
      calls.push({ tool: 'reply', args: input });
      const session = requireSession(input.sessionId);
      session.turn += 1;
      const result = await runScript(session, parseScript(input.prompt), ctx);
      recordTurn(session, result);
      return result;
    },

    async status(input: { sessionId: string; waitSeconds?: number }, ctx: CallContext): Promise<TurnResult> {
      calls.push({ tool: 'status', args: input });
      void ctx;
      const session = requireSession(input.sessionId);
      // v0.3 (F8): reflect the last recorded turn (content/toolCalls/filesChanged) instead of a
      // hardcoded generic snapshot, so detail:"compact"/max-output-chars are observable end to
      // end through opencode-status, the same way a real engine's status() would report them.
      const record = session.turns.get(session.turn);
      return snapshot(session, {
        content: record?.content ?? 'status-snapshot',
        status: 'completed',
        toolCalls: (record?.toolCalls ?? []).map(({ tool, status, title }) => ({ tool, status, title })),
        filesChanged: record?.filesChanged ?? [],
      });
    },

    async list(): Promise<ListResult> {
      calls.push({ tool: 'list', args: {} });
      return {
        kind: 'sessions',
        content: JSON.stringify(calls),
        sessions: Array.from(sessions.values()).map((s) => ({
          sessionId: s.id,
          title: s.id,
          directory: '/stub',
          status: 'idle' as const,
          turns: s.turn,
          updatedAt: 0,
        })),
        truncated: false,
      };
    },

    async cancel(input: { sessionId: string }, ctx: CallContext): Promise<TurnResult> {
      calls.push({ tool: 'cancel', args: input });
      void ctx;
      const session = requireSession(input.sessionId);
      if (session.pendingCancel) {
        const release = session.pendingCancel;
        session.pendingCancel = undefined;
        release();
      }
      return snapshot(session, { status: 'cancelled', content: 'cancelled-by-tool' });
    },

    async end(input: { sessionId: string; action?: EndAction }, ctx: CallContext): Promise<EndResult> {
      calls.push({ tool: 'end', args: input });
      void ctx;
      const session = sessions.get(input.sessionId);
      if (!session) {
        return {
          kind: 'end',
          threadId: input.sessionId,
          sessionId: input.sessionId,
          status: 'not_found',
          action: 'none',
          abortedRunningTurn: false,
          cleanup: 'complete',
          content: 'not found',
        };
      }
      sessions.delete(input.sessionId);
      return {
        kind: 'end',
        threadId: session.id,
        sessionId: session.id,
        status: 'ended',
        action: input.action ?? 'delete',
        abortedRunningTurn: false,
        cleanup: 'complete',
        content: 'ended',
      };
    },

    async shutdown(reason: string): Promise<void> {
      shutdownCallCount += 1;
      calls.push({ tool: 'shutdown', args: { reason } });
      // stderr only (stdout must stay pure JSON-RPC) — the parent test process reads this back
      // to prove shutdown ran exactly once even though the child then exits.
      process.stderr.write(`STUB_SHUTDOWN_CALLED count=${shutdownCallCount} reason=${reason}\n`);
    },

    // v0.3 §1/§2 (F8): pages through whatever content/toolCalls the matching start/reply call
    // actually returned (recordTurn above), so end-to-end wiring tests (arg mapping, paging math,
    // TURN_NOT_FOUND) exercise real data instead of a hardcoded fixture. Deep adversarial/fitting
    // behaviour (surrogate-safe shrinking, the 45000 envelope, …) is unit-tested directly against
    // src/mcp/format.ts, which never sees this stub.
    async output(input: OutputInput, ctx: CallContext): Promise<OutputResult> {
      calls.push({ tool: 'output', args: input });
      void ctx;
      const session = requireSession(input.sessionId);
      if (session.nextOutputError) {
        const err = session.nextOutputError;
        session.nextOutputError = undefined;
        throw new EngineError(err.code, err.message, session.id);
      }
      const record = session.turns.get(input.turn);
      if (!record) throw new EngineError('TURN_NOT_FOUND', `no such turn: ${input.turn}`, session.id);

      const section = input.section ?? 'answer';
      // v0.3 §1 freezes limit's bounds per section (mid-review finding 15: "make the stub honour
      // the contract"): text sections (answer/structured-output/diff-patch) 256..20000, array
      // sections (tool-calls/diff-stat) 1..100. The MCP input schema only bounds `limit` to a
      // section-independent range (src/mcp/tools.ts), so the engine — this stub included — is
      // where the tighter, section-specific minimum is actually enforced.
      const isArraySection = section === 'tool-calls' || (section === 'diff' && (input.diffView ?? 'stat') === 'stat');
      if (input.limit !== undefined) {
        const [min, max] = isArraySection ? [1, 100] : [256, 20000];
        if (input.limit < min || input.limit > max) {
          throw new EngineError(
            'INVALID_ARGUMENT',
            `limit must be ${min}..${max} for section "${section}"${isArraySection ? '' : ' (text sections require >= 256)'}, got ${input.limit}`,
            session.id,
          );
        }
      }
      const turnId = `${session.id}#${input.turn}`;
      const base = {
        kind: 'output' as const,
        status: 'ok' as const,
        sessionId: session.id,
        threadId: session.id,
        turnId,
        turn: input.turn,
        section,
        partial: false,
      };

      if (section === 'tool-calls') {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 20;
        const total = record.toolCalls.length;
        if (offset > total) throw new EngineError('INVALID_ARGUMENT', `offset ${offset} exceeds total ${total}`, session.id);
        const items = record.toolCalls.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        return {
          ...base,
          content: `${items.length} of ${total} tool call(s)`,
          offset,
          nextOffset: nextOffset < total ? nextOffset : null,
          total,
          hasMore: nextOffset < total,
          truncated: false,
          toolCalls: items,
        };
      }

      if (section === 'diff') {
        const diffView = input.diffView ?? 'stat';
        // A10: one-shot override for a huge (schema-unbounded, since it comes from the engine, not
        // a client argument) snapshotId, so format.ts's own last-resort envelope substitution
        // (buildOutputTooLargeError) is reachable end-to-end through the real MCP wiring.
        const hugeSnapshotIdChars = session.nextOutputHugeSnapshotIdChars;
        session.nextOutputHugeSnapshotIdChars = undefined;
        const diffBase = {
          source: 'opencode-snapshot' as const,
          scope: 'user-message' as const,
          sourceMessageId: `msg_${session.id}_${input.turn}_user`,
          snapshotId: hugeSnapshotIdChars
            ? 'x'.repeat(hugeSnapshotIdChars)
            : (input.snapshotId ?? `snap_${session.id}_${input.turn}`),
          observedAt: 0,
          completeness: 'not-guaranteed' as const,
          compacted: false,
        };
        if (diffView === 'patch') {
          const patchText = `--- a/stub.txt\n+++ b/stub.txt\n@@ stub patch for turn ${input.turn} @@\n`;
          const offset = input.offset ?? 0;
          const total = patchText.length;
          if (offset > total) throw new EngineError('INVALID_ARGUMENT', `offset ${offset} exceeds total ${total}`, session.id);
          const limit = input.limit ?? 4000;
          const emitted = patchText.slice(offset, offset + limit);
          const nextOffset = offset + emitted.length;
          return {
            ...base,
            content: emitted,
            offset,
            nextOffset: nextOffset < total ? nextOffset : null,
            total,
            hasMore: nextOffset < total,
            truncated: false,
            diff: { ...diffBase, view: 'patch', patch: { fileIndex: input.fileIndex ?? 0, file: 'stub.txt' } },
          };
        }
        const files = [{ fileIndex: 0, file: 'stub.txt', status: 'modified', additions: 1, deletions: 0, patchChars: 20 }];
        const offset = input.offset ?? 0;
        const total = files.length;
        if (offset > total) throw new EngineError('INVALID_ARGUMENT', `offset ${offset} exceeds total ${total}`, session.id);
        const limit = input.limit ?? 50;
        const items = files.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        return {
          ...base,
          content: `${items.length} of ${total} changed file(s)`,
          offset,
          nextOffset: nextOffset < total ? nextOffset : null,
          total,
          hasMore: nextOffset < total,
          truncated: false,
          diff: { ...diffBase, view: 'stat', files: items },
        };
      }

      // 'answer' | 'structured-output'
      const source = section === 'structured-output' ? JSON.stringify({ stub: true, turn: input.turn }) : record.content;
      const offset = input.offset ?? 0;
      const total = source.length;
      if (offset > total) throw new EngineError('INVALID_ARGUMENT', `offset ${offset} exceeds total ${total}`, session.id);
      const limit = input.limit ?? 4000;
      const emitted = source.slice(offset, offset + limit);
      const nextOffset = offset + emitted.length;
      return {
        ...base,
        content: emitted,
        offset,
        nextOffset: nextOffset < total ? nextOffset : null,
        total,
        hasMore: nextOffset < total,
        truncated: false,
      };
    },

    // v0.3 §5 (F8): server-wide, not session-scoped — canned data, deterministic per section, so
    // wiring tests (section selection, cwd/provider/offset/limit/snapshot-id mapping) are stable.
    async info(input: InfoInput, ctx: CallContext): Promise<InfoResult> {
      calls.push({ tool: 'info', args: input });
      void ctx;
      const section = input.section ?? 'server';

      if (section === 'server') {
        return {
          kind: 'info',
          status: 'ok',
          content: 'stub server info',
          section,
          truncated: false,
          server: {
            mcpVersion: '0.1.0',
            serverInstanceId: 'stub-instance',
            mode: 'managed',
            remotePaths: false,
            connectionState: 'connected',
            opencodeVersion: '0.0.0-stub',
            defaults: {
              cwd: '/stub',
              model: null,
              agent: null,
              sandbox: 'workspace-write',
              approvalPolicy: 'never',
              turnTimeoutSeconds: 600,
              maxTurnTimeoutSeconds: 3600,
            },
            limits: {
              maxOutputChars: 20000,
              structuredContentBudget: 45000,
              maxWaitSeconds: 600,
              maxBatchIds: 16,
              outputRetention: { ttlSeconds: 3600, maxTurns: 128, maxBytes: 33554432 },
              requestIds: { maxRecords: 4096, ttlSeconds: 86400 },
            },
            capabilities: ['stub'],
            sandboxEnforcement: 'permission-profile',
          },
        };
      }

      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;

      if (section === 'models') {
        const all = [
          { model: 'stub/small', providerId: 'stub', modelId: 'small', defaultForProvider: true, toolcall: true },
          { model: 'stub/large', providerId: 'stub', modelId: 'large', defaultForProvider: false, toolcall: true },
        ];
        const page = all.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          kind: 'info',
          status: 'ok',
          content: `${page.length} of ${all.length} model(s)`,
          section,
          truncated: false,
          models: page,
          snapshotId: 'snap_models',
          observedAt: 0,
          availability: 'advertised',
          offset,
          nextOffset: nextOffset < all.length ? nextOffset : null,
          total: all.length,
        };
      }

      if (section === 'agents') {
        const all: Array<{ name: string; mode: 'primary' | 'all' }> = [
          { name: 'build', mode: 'primary' },
          { name: 'plan', mode: 'primary' },
        ];
        const page = all.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          kind: 'info',
          status: 'ok',
          content: `${page.length} of ${all.length} agent(s)`,
          section,
          truncated: false,
          agents: page,
          snapshotId: 'snap_agents',
          observedAt: 0,
          offset,
          nextOffset: nextOffset < all.length ? nextOffset : null,
          total: all.length,
        };
      }

      // 'roots'
      const all = ['/stub/root'];
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        kind: 'info',
        status: 'ok',
        content: `${page.length} of ${all.length} root(s)`,
        section,
        truncated: false,
        roots: page,
        snapshotId: 'snap_roots',
        observedAt: 0,
        offset,
        nextOffset: nextOffset < all.length ? nextOffset : null,
        total: all.length,
      };
    },

    // v0.3 §3 (F8): synchronous stub, so every known id is immediately "ready"; only membership
    // (input order, unknown-id -> per-item error, never a batch failure) needs proving here.
    async statusMany(input: BatchStatusInput, ctx: CallContext): Promise<BatchResult> {
      calls.push({ tool: 'statusMany', args: input });
      void ctx;
      const results: BatchItem[] = input.ids.map((id) => {
        const session = sessions.get(id);
        if (!session) {
          return {
            sessionId: id,
            status: 'error',
            content: '',
            error: { name: 'SESSION_NOT_FOUND', message: `no such session: ${id}` },
          };
        }
        const record = session.turns.get(session.turn);
        return {
          sessionId: session.id,
          status: 'completed',
          turnId: `${session.id}#${session.turn}`,
          turn: session.turn,
          executionState: 'stopped',
          cleanup: 'complete',
          content: record?.content ?? '',
          toolCallCount: record?.toolCalls.length ?? 0,
          filesChangedCount: record?.filesChanged.length ?? 0,
          pendingApprovalCount: 0,
        };
      });
      const readyIds = results.map((r) => r.sessionId);
      return {
        kind: 'batch',
        status: 'ready',
        content: `${readyIds.length} of ${input.ids.length} ready`,
        waitFor: input.waitFor ?? 'any',
        reason: 'condition',
        results,
        readyIds,
        pendingIds: [],
        truncated: false,
      };
    },
  };
}
