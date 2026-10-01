import { OpencodeHttpError } from '../../src/types.ts';
import type {
  Connection,
  ConnectionLease,
  OcEvent,
  OcMessage,
  OcMessagePage,
  OcPermissionRequest,
  OcQuestionRequest,
  OcSession,
  OcSessionStatus,
  OpencodeApi,
  PermissionRule,
  PromptBody,
  RequestOptions,
} from '../../src/types.ts';

type Channel = { queue: OcEvent[]; wake?: () => void; closed: boolean };

/** In-memory OpenCode API with paged history and independent directory streams. */
export class FakeOpencodeApi implements OpencodeApi {
  calls: Array<{ method: string; args: unknown[] }> = [];
  sessions = new Map<string, OcSession>();
  histories = new Map<string, OcMessage[]>();
  statuses = new Map<string, OcSessionStatus>();
  permissions = new Map<string, OcPermissionRequest>();
  questions = new Map<string, OcQuestionRequest>();
  channels = new Map<string, Set<Channel>>();
  subscribeCount = 0;
  autoConnected = true;
  nextSession = 0;
  onPrompt?: (id: string, body: PromptBody) => void | Promise<void>;
  onAbort?: (id: string) => void | Promise<void>;
  onDeleteSession?: (id: string) => void | Promise<void>;
  onArchiveSession?: (id: string) => void | Promise<void>;
  onReplyPermission?: (id: string) => void | Promise<void>;
  promptFailure?: Error;
  abortFailure?: Error;
  abortKeepsBusy = false;
  /** 'aborted-error' (default) writes MessageAbortedError, matching a normal abort. 'retry-no-finish'
   * mirrors OpenCode 1.18.33 aborting during a provider retry sleep: the assistant gets
   * time.completed but no finish and no error (docs/research/opencode-api.md §8). */
  abortShape: 'aborted-error' | 'retry-no-finish' = 'aborted-error';
  /** Emits session.error(MessageAbortedError) before session.idle, matching OpenCode emitting an
   * error event for our own abort ahead of the idle transition. */
  abortEmitsSessionError = false;
  /** FY-2 #6: when set (ms), abort() never settles before its own req.timeoutMs elapses — the
   * caller observes exactly the timeout a genuinely unresponsive server would produce (via
   * awaitGate's real-time race, same as onAbort returning a never-resolving promise) — but the
   * abort's effect still lands `lateAbortDelayMs` ms later, against whichever turn is running for
   * this session at that later moment. That may be a different, later turn than the one this call
   * named: it models a real upstream abort whose HTTP round trip outlived this call's own timeout. */
  lateAbortDelayMs?: number;
  /** Fails the next N messages() calls with a status-0 NetworkError, then resumes normally. */
  messagesFailure = 0;
  /** Fails the next N listPermissions() calls with a status-0 NetworkError, then resumes normally. */
  listPermissionsFailure = 0;
  statusFailure?: Error;
  diffItems: Awaited<ReturnType<OpencodeApi['sessionDiff']>> = [];
  diffFailure?: Error;
  providerResponse: unknown = { connected: [], all: [], default: {} };
  agentResponse: unknown = [];
  simulatePoisoning = false;
  modelResolutionPending = new Set<string>();
  poisonedDirectories = new Set<string>();
  warmedDirectories = new Set<string>();
  health(): Promise<{ healthy: boolean; version: string }> {
    this.record('health');
    return Promise.resolve({ healthy: true, version: '1.18.33' });
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private async awaitGate(work: void | Promise<void>, req?: RequestOptions): Promise<void> {
    if (req?.timeoutMs === undefined) {
      await work;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new OpencodeHttpError('Timed out', 0, 'TimeoutError')), req.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async createSession(
    directory: string,
    body: { title: string; permission?: PermissionRule[] },
  ): Promise<OcSession> {
    this.record('createSession', directory, body);
    const id = `ses_${++this.nextSession}`;
    const session: OcSession = {
      id,
      directory,
      title: body.title,
      time: { created: 0, updated: 0 },
      permission: body.permission,
    };
    this.sessions.set(id, session);
    this.histories.set(id, []);
    return session;
  }

  async getSession(id: string): Promise<OcSession | null> {
    this.record('getSession', id);
    return this.sessions.get(id) ?? null;
  }

  async sessionDiff(sessionId: string, messageId: string, opts: { timeoutMs: number; maxBytes: number }): Promise<Awaited<ReturnType<OpencodeApi['sessionDiff']>>> {
    this.record('sessionDiff', sessionId, messageId, opts);
    if (this.diffFailure) throw this.diffFailure;
    return this.diffItems.map((item) => ({ ...item }));
  }

  async providerCatalog(directory: string, opts: { timeoutMs: number; maxBytes: number }): Promise<unknown> {
    this.record('providerCatalog', directory, opts);
    return this.providerResponse;
  }

  async agentCatalog(directory: string, opts: { timeoutMs: number; maxBytes: number }): Promise<unknown> {
    this.record('agentCatalog', directory, opts);
    return this.agentResponse;
  }

  async promptAsync(id: string, body: PromptBody): Promise<void> {
    this.record('promptAsync', id, body);
    const directory = this.sessions.get(id)?.directory;
    if (directory && this.poisonedDirectories.has(directory)) {
      const history = this.histories.get(id)!;
      const userId = `m${history.length + 1}`;
      const assistantId = `m${history.length + 2}`;
      const error = {
        name: 'UnknownError',
        data: { message: 'All fibers interrupted without error' },
      };
      history.push(
        { info: { id: userId, sessionID: id, role: 'user', time: { created: 0 } }, parts: [] },
        {
          info: {
            id: assistantId,
            sessionID: id,
            role: 'assistant',
            parentID: userId,
            time: { created: 0, completed: 0 },
            error,
          },
          parts: [],
        },
      );
      this.emit(directory, { type: 'session.error', properties: { sessionID: id, error } });
      return;
    }
    await this.onPrompt?.(id, body);
    if (this.promptFailure) throw this.promptFailure;
  }

  async abort(id: string, req?: RequestOptions): Promise<boolean> {
    this.record('abort', id, req);
    if (this.lateAbortDelayMs !== undefined) {
      const delay = this.lateAbortDelayMs;
      const directory = this.sessions.get(id)?.directory;
      setTimeout(() => this.applyLateAbort(id, directory), delay);
      // Never settles before req.timeoutMs: the same real-timer race awaitGate always runs, given a
      // `work` promise (here, one that never resolves) that outlives the deadline.
      return this.awaitGate(new Promise<void>(() => {}), req).then(() => true);
    }
    await this.awaitGate(this.onAbort?.(id), req);
    if (this.abortFailure) throw this.abortFailure;
    const directory = this.sessions.get(id)?.directory;
    if (
      directory &&
      this.simulatePoisoning &&
      this.modelResolutionPending.has(directory) &&
      !this.warmedDirectories.has(directory)
    ) {
      this.poisonedDirectories.add(directory);
      this.modelResolutionPending.delete(directory);
    }
    if (!this.abortKeepsBusy) {
      const history = this.histories.get(id);
      const user = [...(history ?? [])]
        .reverse()
        .find((item) => item.info.role === 'user' && !item.info.parentID);
      const hasAssistant =
        user && history?.some((item) => item.info.role === 'assistant' && item.info.id > user.info.id);
      // A busy fake runner records its aborted assistant; abort with no runner only emits idle.
      if (!this.onAbort && this.statuses.has(id) && user && !hasAssistant && history) {
        const width = user.info.id.length - 1;
        const next = Number(user.info.id.slice(1)) + 1;
        const messageId = `m${String(next).padStart(width, '0')}`;
        history.push({
          info: {
            id: messageId,
            sessionID: id,
            role: 'assistant',
            parentID: user.info.id,
            time: { created: 0, completed: 0 },
            // 'retry-no-finish' leaves no error/finish, matching an abort during provider retry.
            ...(this.abortShape === 'retry-no-finish'
              ? {}
              : { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }),
          },
          parts: [],
        });
      }
      if (this.abortEmitsSessionError) {
        this.emit(directory ?? '', {
          type: 'session.error',
          properties: {
            sessionID: id,
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          },
        });
      }
      this.statuses.delete(id);
      this.emit(this.sessions.get(id)?.directory ?? '', {
        type: 'session.idle',
        properties: { sessionID: id },
      });
    }
    return true;
  }

  /** FY-2 #6: the delayed side effect of a `lateAbortDelayMs` abort — applied against whatever
   * (possibly later, possibly different) turn is running for this session when the real timer
   * fires, exactly like OpenCode's own abort endpoint stops whatever the session is doing then. A
   * session that has since gone idle has nothing to abort: a no-op, not an error. */
  private applyLateAbort(id: string, directory: string | undefined): void {
    if (this.abortKeepsBusy || !this.statuses.has(id)) return;
    const history = this.histories.get(id);
    const user = [...(history ?? [])]
      .reverse()
      .find((item) => item.info.role === 'user' && !item.info.parentID);
    const hasAssistant =
      user && history?.some((item) => item.info.role === 'assistant' && item.info.id > user.info.id);
    if (user && !hasAssistant && history) {
      const width = user.info.id.length - 1;
      const next = Number(user.info.id.slice(1)) + 1;
      const messageId = `m${String(next).padStart(width, '0')}`;
      history.push({
        info: {
          id: messageId,
          sessionID: id,
          role: 'assistant',
          parentID: user.info.id,
          time: { created: 0, completed: 0 },
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
        },
        parts: [],
      });
    }
    this.statuses.delete(id);
    this.emit(directory ?? this.sessions.get(id)?.directory ?? '', {
      type: 'session.idle',
      properties: { sessionID: id },
    });
  }

  async deleteSession(id: string, req?: RequestOptions): Promise<boolean> {
    this.record('deleteSession', id, req);
    await this.awaitGate(this.onDeleteSession?.(id), req);
    return this.sessions.delete(id);
  }

  async archiveSession(id: string, at: number, req?: RequestOptions): Promise<OcSession> {
    this.record('archiveSession', id, at, req);
    await this.awaitGate(this.onArchiveSession?.(id), req);
    const s = this.sessions.get(id);
    if (!s) throw Error('missing');
    s.time.archived = at;
    return s;
  }

  async messages(id: string, opts: { limit?: number; before?: string } = {}): Promise<OcMessagePage> {
    this.record('messages', id, opts);
    if (this.messagesFailure > 0) {
      this.messagesFailure--;
      throw new OpencodeHttpError('Simulated messages() failure', 0, 'NetworkError');
    }
    const all = this.histories.get(id) ?? [];
    const end = opts.before
      ? Math.max(
          0,
          all.findIndex((x) => x.info.id === opts.before),
        )
      : all.length;
    const start = Math.max(0, end - (opts.limit ?? 100));
    const items = all.slice(start, end);
    return { items, ...(start > 0 ? { nextCursor: all[start]!.info.id } : {}) };
  }

  async sessionStatus(directory: string): Promise<Record<string, OcSessionStatus>> {
    this.record('sessionStatus', directory);
    if (this.statusFailure) throw this.statusFailure;
    return Object.fromEntries(
      [...this.statuses].filter(([id]) => this.sessions.get(id)?.directory === directory),
    );
  }

  async listPermissions(directory: string): Promise<OcPermissionRequest[]> {
    this.record('listPermissions', directory);
    if (this.listPermissionsFailure > 0) {
      this.listPermissionsFailure--;
      throw new OpencodeHttpError('Simulated listPermissions() failure', 0, 'NetworkError');
    }
    return [...this.permissions.values()].filter(
      (x) => this.sessions.get(x.sessionID)?.directory === directory,
    );
  }

  async replyPermission(
    directory: string,
    id: string,
    reply: 'once' | 'reject',
    message?: string,
    req?: RequestOptions,
  ): Promise<boolean> {
    this.record('replyPermission', directory, id, reply, message, req);
    await this.awaitGate(this.onReplyPermission?.(id), req);
    const target = this.permissions.get(id);
    const removed = this.permissions.delete(id);
    if (removed && target) {
      this.emit(directory, { type: 'permission.replied', properties: { sessionID: target.sessionID, requestID: id, reply } });
      // F7: a 'reject' reply cascades to every other pending permission of the same session.
      if (reply === 'reject') {
        for (const other of [...this.permissions.values()])
          if (other.sessionID === target.sessionID) {
            this.permissions.delete(other.id);
            this.emit(directory, {
              type: 'permission.replied',
              properties: { sessionID: other.sessionID, requestID: other.id, reply: 'reject' },
            });
          }
      }
    }
    return removed;
  }

  async listQuestions(directory: string): Promise<OcQuestionRequest[]> {
    this.record('listQuestions', directory);
    return [...this.questions.values()].filter(
      (x) => this.sessions.get(x.sessionID)?.directory === directory,
    );
  }

  async rejectQuestion(directory: string, id: string): Promise<boolean> {
    this.record('rejectQuestion', directory, id);
    return this.questions.delete(id);
  }

  async warmInstance(directory: string, req?: RequestOptions): Promise<{ providerCatalog: unknown }> {
    this.record('warmInstance', directory, req);
    this.warmedDirectories.add(directory);
    this.modelResolutionPending.delete(directory);
    return { providerCatalog: this.providerResponse ?? {} };
  }

  async disposeInstance(directory: string, req?: RequestOptions): Promise<boolean> {
    this.record('disposeInstance', directory, req);
    this.poisonedDirectories.delete(directory);
    this.warmedDirectories.delete(directory);
    this.modelResolutionPending.delete(directory);
    return true;
  }

  emit(directory: string, event: OcEvent): void {
    for (const channel of this.channels.get(directory) ?? []) {
      channel.queue.push(event);
      channel.wake?.();
    }
  }

  disconnect(directory: string): void {
    for (const channel of this.channels.get(directory) ?? []) {
      channel.closed = true;
      channel.wake?.();
    }
  }

  async *subscribe(directory: string, signal: AbortSignal): AsyncIterable<OcEvent> {
    this.record('subscribe', directory);
    this.subscribeCount++;
    const channel: Channel = {
      queue: this.autoConnected ? [{ type: 'server.connected', properties: {} }] : [],
      closed: false,
    };
    const set = this.channels.get(directory) ?? new Set<Channel>();
    set.add(channel);
    this.channels.set(directory, set);
    const abort = () => {
      channel.closed = true;
      channel.wake?.();
    };
    signal.addEventListener('abort', abort);
    try {
      while (!channel.closed) {
        if (channel.queue.length) {
          yield channel.queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          channel.wake = () => resolve();
        });
        channel.wake = undefined;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      set.delete(channel);
    }
  }
}

/** A controllable connection lease and generation source for turn tests. */
export class FakeConnection implements Connection {
  api = new FakeOpencodeApi();
  generation = 1;
  closed = false;
  live = false;
  private listeners = new Set<(generation: number, error: Error, kind: 'exited' | 'unreachable') => void>();
  async acquire(_req?: RequestOptions): Promise<ConnectionLease> {
    this.live = true;
    return { api: this.api, generation: this.generation, version: '1.18.33' };
  }

  current(): ConnectionLease | undefined {
    return this.live && !this.closed
      ? { api: this.api, generation: this.generation, version: '1.18.33' }
      : undefined;
  }

  onUnavailable(listener: (generation: number, error: Error, kind: 'exited' | 'unreachable') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  unavailable(kind: 'exited' | 'unreachable' = 'exited'): void {
    const prior = this.generation++;
    this.live = false;
    for (const listener of this.listeners) listener(prior, new Error('unavailable'), kind);
  }

  async invalidate(generation: number, reason: 'unreachable' | 'hung'): Promise<void> {
    if (!this.live || generation !== this.generation) return;
    this.unavailable(reason === 'hung' ? 'exited' : 'unreachable');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.live = false;
  }
}
