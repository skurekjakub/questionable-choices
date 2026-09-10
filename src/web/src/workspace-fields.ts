/**
 * Request paths the add-workspace dialog has a field for, in the order they are
 * rendered.
 */
const FIELD_PATHS = [
  'name',
  'epic',
  'repo',
  'connector',
  'newConnector.id',
  'newConnector.site',
  'newConnector.emailEnv',
  'newConnector.tokenEnv',
  'reviewStatuses',
] as const;

/**
 * One request field a validation issue can be placed against.
 */
export type WorkspaceFieldPath = (typeof FIELD_PATHS)[number];

/**
 * Whether a string is one of the fields the add-workspace dialog renders.
 *
 * @param path - Candidate path.
 * @returns True when a field carries that path.
 */
function isFieldPath(path: string): path is WorkspaceFieldPath {
  return (FIELD_PATHS as readonly string[]).includes(path);
}

/**
 * Decides which field of the add-workspace dialog a validation issue belongs
 * next to.
 *
 * `POST /api/workspaces` reports every issue against the request that produced
 * it, so the paths are the request's own field names — `epic`,
 * `newConnector.site` — plus `id` for a workspace id derived from the name, and
 * an index on a list field, as in `reviewStatuses[0]`.
 *
 * @param path - Path the server sent with the issue.
 * @returns The field to render it against, or null when it names none.
 */
export function placeIssue(path: string): WorkspaceFieldPath | null {
  // One bad entry faults the whole list: the dialog edits the statuses as one
  // comma-separated string and has nowhere to put an index.
  const field = path.replace(/\[\d+\]$/, '');
  if (isFieldPath(field)) return field;
  // The workspace id is derived from the name, so a clash is a name to change.
  if (field === 'id') return 'name';
  return null;
}

/**
 * Drops the problems the server placed against one field.
 *
 * A message about a value the owner has since replaced is worse than no message
 * at all: a screen reader keeps announcing it, and the control keeps reporting
 * itself invalid, until the next submit.
 *
 * @param issues - Problems the server reported, in the order it sent them.
 * @param field - Field whose problems should go.
 * @returns The problems belonging to every other field, in the same order.
 */
export function withoutField<T extends { path: string }>(
  issues: readonly T[],
  field: WorkspaceFieldPath,
): T[] {
  return issues.filter((issue) => placeIssue(issue.path) !== field);
}
