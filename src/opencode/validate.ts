// Runtime shape validation for OpenCode admission-read responses. Message/status/permission
// reads used to cast parsed JSON into TypeScript types without checking it; this module
// validates the shape at the boundary instead (overload design; summarized in
// docs/design.md §12). Every function here rejects a non-array/non-object (or otherwise unusable)
// body as OpencodeHttpError('ProtocolError') instead of letting a malformed upstream response
// propagate as a raw TypeError once dereferenced deeper in the engine/turn evidence logic.

import { OpencodeHttpError } from '../types.ts';

import type { OcMessage, OcPermissionRequest, OcQuestionRequest, OcSessionStatus } from '../types.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function protocolError(status: number, detail: string): OpencodeHttpError {
  return new OpencodeHttpError(`malformed OpenCode response: ${detail}`, status, 'ProtocolError');
}

/** Validates a `messages()` page body: an array of `{info: {...}, parts: [...]}` entries. Only
 * the fields the engine's evidence logic actually relies on are checked; unknown extra fields are
 * left as-is (the OpenCode API is versioned loosely, `OcMessage`/`OcPart` both allow unknown
 * keys). */
export function validateMessagePage(value: unknown, status: number): OcMessage[] {
  if (!Array.isArray(value)) throw protocolError(status, 'expected an array of messages');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw protocolError(status, `message[${index}] is not an object`);
    const info = entry.info;
    if (!isPlainObject(info)) throw protocolError(status, `message[${index}].info is not an object`);
    if (typeof info.id !== 'string' || info.id.length === 0) {
      throw protocolError(status, `message[${index}].info.id is not a non-empty string`);
    }
    if (typeof info.sessionID !== 'string') {
      throw protocolError(status, `message[${index}].info.sessionID is not a string`);
    }
    if (info.role !== 'user' && info.role !== 'assistant') {
      throw protocolError(status, `message[${index}].info.role is invalid`);
    }
    const time = info.time;
    if (!isPlainObject(time) || typeof time.created !== 'number' || !Number.isFinite(time.created)) {
      throw protocolError(status, `message[${index}].info.time.created is not a finite number`);
    }
    if (!Array.isArray(entry.parts)) {
      throw protocolError(status, `message[${index}].parts is not an array`);
    }
    return entry as unknown as OcMessage;
  });
}

/** Validates a `sessionStatus()` body: an object keyed by session id, each value one of
 * `{type:'idle'}`, `{type:'busy'}`, or `{type:'retry', attempt, message, next}`. */
export function validateSessionStatusMap(value: unknown, status: number): Record<string, OcSessionStatus> {
  if (!isPlainObject(value)) throw protocolError(status, 'expected an object keyed by session id');
  for (const [sessionId, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) throw protocolError(status, `status[${sessionId}] is not an object`);
    if (entry.type === 'idle' || entry.type === 'busy') continue;
    if (entry.type === 'retry') {
      if (
        typeof entry.attempt !== 'number' ||
        !Number.isFinite(entry.attempt) ||
        typeof entry.message !== 'string' ||
        typeof entry.next !== 'number' ||
        !Number.isFinite(entry.next)
      ) {
        throw protocolError(status, `status[${sessionId}] retry entry is missing attempt/message/next`);
      }
      continue;
    }
    throw protocolError(status, `status[${sessionId}].type is invalid`);
  }
  return value as Record<string, OcSessionStatus>;
}

/** Validates a `listPermissions()` body: an array of permission requests. */
export function validatePermissionList(value: unknown, status: number): OcPermissionRequest[] {
  if (!Array.isArray(value)) throw protocolError(status, 'expected an array of permission requests');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw protocolError(status, `permission[${index}] is not an object`);
    if (typeof entry.id !== 'string' || typeof entry.sessionID !== 'string' || typeof entry.permission !== 'string') {
      throw protocolError(status, `permission[${index}] is missing a required string field`);
    }
    if (!Array.isArray(entry.patterns) || !Array.isArray(entry.always)) {
      throw protocolError(status, `permission[${index}].patterns/always is not an array`);
    }
    if (!isPlainObject(entry.metadata)) {
      throw protocolError(status, `permission[${index}].metadata is not an object`);
    }
    return entry as unknown as OcPermissionRequest;
  });
}

/** Validates a `listQuestions()` body: an array of question requests. */
export function validateQuestionList(value: unknown, status: number): OcQuestionRequest[] {
  if (!Array.isArray(value)) throw protocolError(status, 'expected an array of question requests');
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw protocolError(status, `question[${index}] is not an object`);
    if (typeof entry.id !== 'string' || typeof entry.sessionID !== 'string') {
      throw protocolError(status, `question[${index}] is missing a required string field`);
    }
    if (!Array.isArray(entry.questions)) {
      throw protocolError(status, `question[${index}].questions is not an array`);
    }
    return entry as unknown as OcQuestionRequest;
  });
}
