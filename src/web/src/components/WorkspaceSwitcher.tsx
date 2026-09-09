import { useCallback, useState, type JSX } from 'react';
import type { WorkspaceSummary } from '../../../core/api.js';
import { useMenuKeys } from '../hooks/useMenuKeys.js';

/**
 * Lists the epics the board can switch between, and the two actions that
 * change the list.
 *
 * @param props - Component props.
 * @param props.workspaces - Workspaces offered, in configuration order.
 * @param props.workspaceId - Id of the workspace currently shown.
 * @param props.onSelect - Called with the id the owner picked.
 * @param props.onAdd - Called when the owner wants to add a workspace.
 * @param props.onRemove - Called when the owner wants to remove the active one.
 * @returns The switcher element.
 */
export function WorkspaceSwitcher({
  workspaces,
  workspaceId,
  onSelect,
  onAdd,
  onRemove,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  onAdd: () => void;
  onRemove: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { anchor, panel } = useMenuKeys(open, close);
  const active = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  return (
    <div className="switcher" ref={anchor}>
      <button
        type="button"
        className="switcher-trigger"
        aria-label="Workspace"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        <span>{active?.name ?? 'No workspace'}</span>
        <span className="epic">{active?.epic ?? ''}</span>
      </button>
      {open ? (
        <div className="switcher-panel" role="menu" aria-label="Workspace" ref={panel}>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === workspaceId}
              onClick={() => {
                setOpen(false);
                onSelect(workspace.id);
              }}
            >
              <span className="workspace-name">{workspace.name}</span>
              <span className="workspace-meta">
                <span>{workspace.epic}</span>
                <span>{workspace.repo}</span>
              </span>
            </button>
          ))}
          <span className="menu-divider" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            Add workspace…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={active === null}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            Remove this workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}
