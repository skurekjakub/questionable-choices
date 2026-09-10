import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEventLogEntry } from '../core/api.js';
import type { IssueFlags, SessionRecord } from '../core/types.js';
import { messageOf } from './util.js';

/**
 * What the app remembers about the checkout it made for one issue.
 */
export interface WorktreeRecord {
  /** Absolute path of the worktree; only worktrees are recorded, never the main checkout. */
  path: string;
  /** Branch checked out there, or null when the checkout has none of its own. */
  branch: string | null;
}

/**
 * Owner-set issue flags, keyed by workspace id and then by issue key.
 */
export type FlagsByWorkspace = Record<string, Record<string, IssueFlags>>;

/**
 * Known checkouts, keyed by repo id and then by issue key.
 */
export type WorktreesByRepo = Record<string, Record<string, WorktreeRecord>>;

const SESSIONS_FILE = 'sessions.json';
const FLAGS_FILE = 'flags.json';
const WORKTREES_FILE = 'worktrees.json';

/**
 * Longest string kept from a raw hook payload in the event log, in characters.
 *
 * A `PostToolUse` payload carries the whole tool response, so without a cap one
 * session that reads a few hundred large files writes a log the reader cannot
 * hold in a single string.
 */
export const EVENT_STRING_MAX_LENGTH = 4096;

/**
 * Most members kept from one array or object inside a raw event payload.
 *
 * A string cap alone bounds one field; a `tool_response` holding fifty thousand
 * short strings is the other half of the same problem.
 */
export const EVENT_MEMBERS_MAX = 200;

/**
 * Caps the size of a raw event payload: string length, array length and the
 * number of keys on an object.
 *
 * @param value - The payload, whatever shape it arrived in.
 * @returns A copy with anything past a cap replaced by a marked, shortened one.
 */
function capPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= EVENT_STRING_MAX_LENGTH
      ? value
      : `${value.slice(0, EVENT_STRING_MAX_LENGTH)}… [truncated ${String(value.length - EVENT_STRING_MAX_LENGTH)} chars]`;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, EVENT_MEMBERS_MAX).map(capPayload);
    if (value.length > EVENT_MEMBERS_MAX) {
      kept.push(`… [truncated ${String(value.length - EVENT_MEMBERS_MAX)} members]`);
    }
    return kept;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    const capped: Record<string, unknown> = {};
    for (const [key, member] of entries.slice(0, EVENT_MEMBERS_MAX))
      capped[key] = capPayload(member);
    if (entries.length > EVENT_MEMBERS_MAX) {
      capped['…'] = `[truncated ${String(entries.length - EVENT_MEMBERS_MAX)} keys]`;
    }
    return capped;
  }
  return value;
}

/**
 * Suffix a document that failed the shape check is renamed with.
 */
export const REJECTED_SUFFIX = '.rejected';

/**
 * Writes a JSON document so that readers never observe a partial file.
 *
 * Atomicity here means "a reader always sees one whole document, the old one or
 * the new one". It is not a durability guarantee: nothing is fsynced, so a
 * power loss can still lose the write.
 *
 * @param path - Absolute path of the destination file.
 * @param value - Value to serialise.
 * @returns Nothing.
 * @throws {Error} When the directory is unwritable or the rename fails.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // A rename is atomic only within one filesystem, so the temporary file is a
  // sibling of the destination rather than a file under the system temp dir.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, path);
  } catch (cause) {
    // Nothing ever cleans dataDir, so a failed rename would otherwise leave its
    // temporary file beside the document for good.
    await rm(tmp, { force: true });
    throw cause;
  }
}

/**
 * Where a store reports a document it could not use.
 */
export type StoreWarn = (message: string) => void;

/**
 * Reads a JSON document, falling back when it is missing, unreadable or the
 * wrong shape.
 *
 * A document that parses but is not what the caller expects is as unusable as
 * one that does not parse, and a cast would leave every later read of it
 * throwing on a shape nothing reported. A rejected document is renamed to
 * `<name>.rejected` and reported, because the next write of the same file
 * replaces it and a hand-edit that lost a comma would otherwise cost every
 * record it held.
 *
 * @param path - Absolute path of the file to read.
 * @param fallback - Value returned when the document cannot be used.
 * @param coerce - Turns a parsed document into the shape, or null to reject it.
 * @param warn - Where a rejection is reported.
 * @returns The parsed document, or `fallback`.
 */
async function readJson<T>(
  path: string,
  fallback: T,
  coerce: (value: unknown) => T | null,
  warn: StoreWarn,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    await setAside(path, 'it is not JSON', warn);
    return fallback;
  }
  const coerced = coerce(parsed);
  if (coerced !== null) return coerced;
  await setAside(path, 'it is not the shape this file holds', warn);
  return fallback;
}

/**
 * Renames a document the store refused, so the next write cannot destroy it.
 *
 * @param path - Absolute path of the refused document.
 * @param why - Why it was refused, for the log line.
 * @param warn - Where the rejection is reported.
 * @returns Nothing; a rename that itself fails is reported and swallowed.
 */
async function setAside(path: string, why: string, warn: StoreWarn): Promise<void> {
  const kept = `${path}${REJECTED_SUFFIX}`;
  try {
    await rename(path, kept);
    warn(`${path} was not used because ${why}; it has been kept as ${kept}`);
  } catch (cause) {
    warn(`${path} was not used because ${why}, and it could not be kept: ${messageOf(cause)}`);
  }
}

/**
 * Reports whether a parsed value carries the fields every consumer of a session
 * record reads without guarding.
 *
 * @param value - One member of the sessions document.
 * @returns True when the member is usable as a `SessionRecord`.
 */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<SessionRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.issueKey === 'string' &&
    typeof record.repoId === 'string' &&
    typeof record.state === 'string' &&
    typeof record.stateSince === 'string'
  );
}

/**
 * Coerces a parsed sessions document into the records the board can project.
 *
 * The outermost shape decides whether the document is usable at all; a single
 * malformed member is dropped, because one hand-edit must not cost the rest.
 *
 * @param value - The parsed document.
 * @param warn - Where dropped members are reported.
 * @returns The usable records, or null when the document is not an array.
 */
function coerceRecords(value: unknown, warn: StoreWarn): SessionRecord[] | null {
  if (!Array.isArray(value)) return null;
  const kept = value.filter(isSessionRecord);
  if (kept.length !== value.length) {
    warn(`${String(value.length - kept.length)} session record(s) were dropped as unusable`);
  }
  return kept;
}

/**
 * Coerces a parsed document into a plain object.
 *
 * @param value - The parsed document.
 * @returns The object, or null when the document is not a non-array object.
 */
function coerceObject<T>(value: unknown): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : null;
}

/**
 * Durable state of the dashboard: session records, issue flags and the
 * checkouts it created, plus the per-session raw event log.
 *
 * Every mutator writes its whole file through a temporary file and a rename,
 * and writes to one file are serialised, so a crash mid-write leaves the
 * previous document intact.
 */
export class Store {
  /** Absolute directory the documents live in. */
  readonly dataDir: string;

  private records: SessionRecord[] = [];
  private flags: FlagsByWorkspace = {};
  private worktrees: WorktreesByRepo = {};
  private queue: Promise<void> = Promise.resolve();
  private readonly eventDirsMade = new Set<string>();
  private readonly warn: StoreWarn;

  /**
   * Builds a store over a data directory. Nothing is read until `load` runs.
   *
   * @param dataDir - Absolute directory holding the JSON documents.
   * @param warn - Where a document the store refuses is reported; defaults to
   *   the process console.
   */
  constructor(dataDir: string, warn: StoreWarn = (message) => console.warn(message)) {
    this.dataDir = dataDir;
    this.warn = warn;
  }

  /**
   * Creates the data directory and reads whatever is already in it.
   *
   * A document that is missing, unparseable or not the shape its file holds is
   * treated as empty and kept as `<name>.rejected`, so the next write cannot
   * destroy it and the dashboard still boots.
   *
   * @returns Nothing.
   * @throws {Error} When the data directory cannot be created.
   */
  async load(): Promise<void> {
    await mkdir(join(this.dataDir, 'sessions'), { recursive: true });
    this.records = await readJson<SessionRecord[]>(
      this.path(SESSIONS_FILE),
      [],
      (value) => coerceRecords(value, this.warn),
      this.warn,
    );
    this.flags = await readJson<FlagsByWorkspace>(
      this.path(FLAGS_FILE),
      {},
      coerceObject,
      this.warn,
    );
    this.worktrees = await readJson<WorktreesByRepo>(
      this.path(WORKTREES_FILE),
      {},
      coerceObject,
      this.warn,
    );
  }

  /**
   * Absolute path of one document in the data directory.
   *
   * @param name - File name relative to the data directory.
   * @returns The absolute path.
   */
  private path(name: string): string {
    return join(this.dataDir, name);
  }

  /**
   * Serialises writes so two mutators cannot interleave their renames.
   *
   * @param work - The write to run once the queue drains.
   * @returns Nothing, once the write has completed.
   * @throws {Error} Whatever `work` threw.
   */
  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Every session record the app knows about, oldest first.
   *
   * @returns The records; the array is a copy, the records are not.
   */
  sessions(): SessionRecord[] {
    return [...this.records];
  }

  /**
   * Looks one session record up by id.
   *
   * @param id - Session id, which is also the tmux session name.
   * @returns The record, or undefined when no session has that id.
   */
  session(id: string): SessionRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  /**
   * Inserts or replaces one session record and persists the file.
   *
   * @param record - The record to store; its `id` is the identity.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  async saveSession(record: SessionRecord): Promise<void> {
    const index = this.records.findIndex((existing) => existing.id === record.id);
    const previous = index === -1 ? undefined : this.records[index];
    if (index === -1) this.records.push(record);
    else this.records[index] = record;
    // Memory is what every later read answers from, so a failed write has to
    // take the in-memory value with it; otherwise the dashboard shows a session
    // that vanishes on the next boot. The undo is by identity, never by array
    // snapshot: a snapshot taken before a concurrent save would drop that
    // save's record along with this one's.
    try {
      await this.enqueue(() => writeJsonAtomic(this.path(SESSIONS_FILE), this.records));
    } catch (cause) {
      const current = this.records.findIndex((existing) => existing.id === record.id);
      if (current !== -1) {
        if (previous === undefined) this.records.splice(current, 1);
        else this.records[current] = previous;
      }
      throw cause;
    }
  }

  /**
   * Flags of every issue on one workspace.
   *
   * @param workspaceId - Workspace whose flags to read.
   * @returns The flags keyed by issue key; empty when the workspace has none.
   */
  flagsOf(workspaceId: string): Record<string, IssueFlags> {
    return this.flags[workspaceId] ?? {};
  }

  /**
   * Merges a flag patch into one issue's flags and persists the file.
   *
   * A flag set to false is removed rather than stored, so `flags.json` holds
   * only the overrides the owner actually set.
   *
   * @param workspaceId - Workspace the issue belongs to.
   * @param issueKey - Key of the issue whose flags change.
   * @param patch - Flags to set; an explicit false clears the flag.
   * @returns The issue's flags after the merge.
   * @throws {Error} When the file cannot be written.
   */
  async setFlags(workspaceId: string, issueKey: string, patch: IssueFlags): Promise<IssueFlags> {
    const perWorkspace = this.flags[workspaceId] ?? {};
    const merged: IssueFlags = { ...(perWorkspace[issueKey] ?? {}) };
    if (patch.review !== undefined) {
      if (patch.review) merged.review = true;
      else delete merged.review;
    }
    if (patch.done !== undefined) {
      if (patch.done) merged.done = true;
      else delete merged.done;
    }
    const previous = perWorkspace[issueKey];
    perWorkspace[issueKey] = merged;
    this.flags[workspaceId] = perWorkspace;
    try {
      await this.enqueue(() => writeJsonAtomic(this.path(FLAGS_FILE), this.flags));
    } catch (cause) {
      if (previous === undefined) delete perWorkspace[issueKey];
      else perWorkspace[issueKey] = previous;
      throw cause;
    }
    return merged;
  }

  /**
   * Checkouts known for every issue in one repo.
   *
   * @param repoId - Repo whose checkouts to read.
   * @returns The checkouts keyed by issue key; empty when there are none.
   */
  worktreesOf(repoId: string): Record<string, WorktreeRecord> {
    return this.worktrees[repoId] ?? {};
  }

  /**
   * Looks one issue's checkout up.
   *
   * @param repoId - Repo the checkout was made in.
   * @param issueKey - Key of the issue.
   * @returns The checkout, or undefined when the issue has none.
   */
  worktree(repoId: string, issueKey: string): WorktreeRecord | undefined {
    return this.worktrees[repoId]?.[issueKey];
  }

  /**
   * Records the checkout made for one issue and persists the file.
   *
   * @param repoId - Repo the checkout was made in.
   * @param issueKey - Key of the issue.
   * @param worktree - The checkout to remember.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  async setWorktree(repoId: string, issueKey: string, worktree: WorktreeRecord): Promise<void> {
    const perRepo = this.worktrees[repoId] ?? {};
    const previous = perRepo[issueKey];
    perRepo[issueKey] = worktree;
    this.worktrees[repoId] = perRepo;
    try {
      await this.enqueue(() => writeJsonAtomic(this.path(WORKTREES_FILE), this.worktrees));
    } catch (cause) {
      if (previous === undefined) delete perRepo[issueKey];
      else perRepo[issueKey] = previous;
      throw cause;
    }
  }

  /**
   * Forgets the checkout made for one issue and persists the file.
   *
   * @param repoId - Repo the checkout was made in.
   * @param issueKey - Key of the issue whose checkout is gone.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  async clearWorktree(repoId: string, issueKey: string): Promise<void> {
    const perRepo = this.worktrees[repoId];
    if (perRepo === undefined || perRepo[issueKey] === undefined) return;
    const previous = perRepo[issueKey];
    delete perRepo[issueKey];
    try {
      await this.enqueue(() => writeJsonAtomic(this.path(WORKTREES_FILE), this.worktrees));
    } catch (cause) {
      perRepo[issueKey] = previous;
      throw cause;
    }
  }

  /**
   * Absolute directory holding one session's generated files and event log.
   *
   * @param sessionId - Session id.
   * @returns The absolute directory path; it may not exist yet.
   */
  sessionDir(sessionId: string): string {
    return join(this.dataDir, 'sessions', sessionId);
  }

  /**
   * Appends one accepted event to a session's raw event log.
   *
   * The raw payload is capped — strings at `EVENT_STRING_MAX_LENGTH`, arrays
   * and objects at `EVENT_MEMBERS_MAX` members — so one event cannot cost as
   * much as a whole hook request body.
   *
   * @param sessionId - Session the event belongs to.
   * @param entry - Timestamp, raw payload and the state the event produced.
   * @returns Nothing.
   * @throws {Error} When the log cannot be created or appended to.
   */
  async appendEvent(sessionId: string, entry: SessionEventLogEntry): Promise<void> {
    const dir = this.sessionDir(sessionId);
    if (!this.eventDirsMade.has(sessionId)) {
      await mkdir(dir, { recursive: true });
      this.eventDirsMade.add(sessionId);
    }
    const capped: SessionEventLogEntry = { ...entry, event: capPayload(entry.event) };
    const line = `${JSON.stringify(capped)}\n`;
    const log = join(dir, 'events.jsonl');
    try {
      await appendFile(log, line, 'utf8');
    } catch (cause) {
      // A session directory removed under the running server would otherwise
      // make every later append fail, because the cache says the mkdir is done.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      await mkdir(dir, { recursive: true });
      await appendFile(log, line, 'utf8');
    }
  }

  /**
   * Reads a session's raw event log.
   *
   * Unparseable lines are skipped, so a truncated final line from a crash does
   * not make the whole log unreadable.
   *
   * @param sessionId - Session whose log to read.
   * @returns The accepted events, oldest first; empty when there is no log.
   * @throws {Error} When a log exists but cannot be read.
   */
  async readEvents(sessionId: string): Promise<SessionEventLogEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.sessionDir(sessionId), 'events.jsonl'), 'utf8');
    } catch (cause) {
      // Only "there is no log" is an empty log. Anything else — a permission
      // problem, a log past the maximum string length — must reach the caller,
      // or the route reports "the hooks never fired" for a log it could not open.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }
    const entries: SessionEventLogEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as SessionEventLogEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }
}
