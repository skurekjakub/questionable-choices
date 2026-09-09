import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEventLogEntry } from '../core/api.js';
import type { IssueFlags, SessionRecord } from '../core/types.js';

/**
 * What the app remembers about the checkout it made for one issue.
 */
export interface WorktreeRecord {
  /** Absolute path of the worktree, or of the repo for isolation `shared`. */
  path: string;
  /** Branch checked out there, or null when the checkout has none of its own. */
  branch: string | null;
  /** Whether the repo's bootstrap command has already run there. */
  bootstrapped: boolean;
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
 * Reads a JSON document, falling back when it is missing or unreadable.
 *
 * @param path - Absolute path of the file to read.
 * @param fallback - Value returned when the file cannot be read or parsed.
 * @returns The parsed document, or `fallback`.
 */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
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
   * A missing or corrupt document is treated as empty rather than fatal, so a
   * hand-edited file cannot stop the dashboard from booting.
   *
   * @returns Nothing.
   * @throws {Error} When the data directory cannot be created.
   */
  async load(): Promise<void> {
    await mkdir(join(this.dataDir, 'sessions'), { recursive: true });
    this.records = await readJson<SessionRecord[]>(this.path(SESSIONS_FILE), []);
    this.flags = await readJson<FlagsByWorkspace>(this.path(FLAGS_FILE), {});
    this.worktrees = await readJson<WorktreesByRepo>(this.path(WORKTREES_FILE), {});
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
    if (index === -1) this.records.push(record);
    else this.records[index] = record;
    await this.enqueue(() => writeJsonAtomic(this.path(SESSIONS_FILE), this.records));
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
    perWorkspace[issueKey] = merged;
    this.flags[workspaceId] = perWorkspace;
    await this.enqueue(() => writeJsonAtomic(this.path(FLAGS_FILE), this.flags));
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
    perRepo[issueKey] = worktree;
    this.worktrees[repoId] = perRepo;
    await this.enqueue(() => writeJsonAtomic(this.path(WORKTREES_FILE), this.worktrees));
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
    delete perRepo[issueKey];
    await this.enqueue(() => writeJsonAtomic(this.path(WORKTREES_FILE), this.worktrees));
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
   * @param sessionId - Session the event belongs to.
   * @param entry - Timestamp, raw payload and the state the event produced.
   * @returns Nothing.
   * @throws {Error} When the log cannot be created or appended to.
   */
  async appendEvent(sessionId: string, entry: SessionEventLogEntry): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /**
   * Reads a session's raw event log.
   *
   * Unparseable lines are skipped, so a truncated final line from a crash does
   * not make the whole log unreadable.
   *
   * @param sessionId - Session whose log to read.
   * @returns The accepted events, oldest first; empty when there is no log.
   */
  async readEvents(sessionId: string): Promise<SessionEventLogEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.sessionDir(sessionId), 'events.jsonl'), 'utf8');
    } catch {
      return [];
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
