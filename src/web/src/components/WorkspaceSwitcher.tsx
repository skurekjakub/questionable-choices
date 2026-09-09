import { useEffect, useRef, useState, type JSX } from 'react';
import type { WorkspaceSummary } from '../../../core/api.js';

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
  const anchor = useRef<HTMLDivElement>(null);
  const active = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (anchor.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
        <div className="switcher-panel" role="menu">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              aria-current={workspace.id === workspaceId}
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
