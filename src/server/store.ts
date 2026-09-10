import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEventLogEntry } from '../core/api.js';
import type { IssueFlags, SessionRecord } from '../core/types.js';

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
 * Truncates every string inside a raw event payload.
 *
 * @param value - The payload, whatever shape it arrived in.
 * @returns A copy with long strings replaced by a truncated, marked version.
 */
function capStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= EVENT_STRING_MAX_LENGTH
      ? value
      : `${value.slice(0, EVENT_STRING_MAX_LENGTH)}… [truncated ${String(value.length - EVENT_STRING_MAX_LENGTH)} chars]`;
  }
  if (Array.isArray(value)) return value.map(capStrings);
  if (typeof value === 'object' && value !== null) {
    const capped: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) capped[key] = capStrings(member);
    return capped;
  }
  return value;
}

/**
 * Writes a JSON document so that readers never observe a partial file.
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
  await rename(tmp, path);
}

/**
 * Reads a JSON document, falling back when it is missing, unreadable or the
 * wrong shape.
 *
 * A document that parses but is not what the caller expects is as unusable as
 * one that does not parse, and a cast would leave every later read of it
 * throwing on a shape nothing reported.
 *
 * @param path - Absolute path of the file to read.
 * @param fallback - Value returned when the document cannot be used.
 * @param isShape - Predicate the parsed document must satisfy.
 * @returns The parsed document, or `fallback`.
 */
async function readJson<T>(
  path: string,
  fallback: T,
  isShape: (value: unknown) => value is T,
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
    return fallback;
  }
  return isShape(parsed) ? parsed : fallback;
}

/**
 * Reports whether a parsed document is an array.
 *
 * @param value - The parsed document.
 * @returns True when the document is an array.
 */
function isRecordArray(value: unknown): value is SessionRecord[] {
  return Array.isArray(value);
}

/**
 * Reports whether a parsed document is a plain object.
 *
 * @param value - The parsed document.
 * @returns True when the document is a non-null, non-array object.
 */
function isPlainObject<T>(value: unknown): value is T {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  /**
   * Builds a store over a data directory. Nothing is read until `load` runs.
   *
   * @param dataDir - Absolute directory holding the JSON documents.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Creates the data directory and reads whatever is already in it.
   *
   * A document that is missing, unparseable or not the shape it should be is
   * treated as empty, so a hand-edited file costs the state it held rather than
   * leaving the dashboard answering every later request with a 500.
   *
   * @returns Nothing.
   * @throws {Error} When the data directory cannot be created.
   */
  async load(): Promise<void> {
    await mkdir(join(this.dataDir, 'sessions'), { recursive: true });
    this.records = await readJson<SessionRecord[]>(this.path(SESSIONS_FILE), [], isRecordArray);
    this.flags = await readJson<FlagsByWorkspace>(this.path(FLAGS_FILE), {}, isPlainObject);
    this.worktrees = await readJson<WorktreesByRepo>(this.path(WORKTREES_FILE), {}, isPlainObject);
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
    const previous = [...this.records];
    const index = this.records.findIndex((existing) => existing.id === record.id);
    if (index === -1) this.records.push(record);
    else this.records[index] = record;
    // Memory is what every later read answers from, so a failed write has to
    // take the in-memory value with it; otherwise the dashboard shows a session
    // that vanishes on the next boot.
    try {
      await this.enqueue(() => writeJsonAtomic(this.path(SESSIONS_FILE), this.records));
    } catch (cause) {
      this.records = previous;
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
   * Strings inside the raw payload are capped at `EVENT_STRING_MAX_LENGTH`, so
   * one event cannot cost as much as a whole hook request body.
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
    const capped: SessionEventLogEntry = { ...entry, event: capStrings(entry.event) };
    await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify(capped)}\n`, 'utf8');
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
