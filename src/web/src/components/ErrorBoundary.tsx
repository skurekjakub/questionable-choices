import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';
import { NAVIGATE_EVENT } from '../navigation.js';

/**
 * Shown when the thrown value carried no words of its own.
 */
const UNWORDED = 'no message';

/**
 * Renders the failure in place of the tree that threw.
 *
 * @param message - Message of the error that unmounted the tree.
 * @param retry - Clears the failure and re-renders the tree.
 * @returns What to show instead of the children.
 */
export type ErrorFallback = (message: string, retry: () => void) => ReactNode;

/**
 * Props of {@link ErrorBoundary}.
 */
export interface ErrorBoundaryProps {
  /** Tree to render while nothing has thrown. */
  children: ReactNode;
  /**
   * Renders the failure. Omitted, the boundary renders the whole-dashboard
   * panel, which is only right for a boundary that has the whole dashboard
   * under it.
   */
  fallback?: ErrorFallback;
}

/**
 * State of {@link ErrorBoundary}.
 */
export interface ErrorBoundaryState {
  /** Message of the error that unmounted the tree, or null while it is healthy. */
  message: string | null;
  /** Pathname the failure happened on, so leaving it clears the failure. */
  path: string | null;
}

/**
 * Reduces a thrown value to a sentence worth showing.
 *
 * @param error - Value thrown below the boundary.
 * @returns The error's own words, or a stand-in when it has none.
 */
function wordsOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : UNWORDED;
}

/**
 * Catches a throw from anywhere below it and shows what happened instead of a
 * blank page.
 *
 * A dashboard whose job is to tell the owner that something needs them must not
 * answer a thrown render or effect with an empty document, and must not stay
 * answered that way: the failure clears when the owner navigates away from the
 * route it happened on, and *Try again* clears it in place. Both matter because
 * an unmounted app is a torn-down event socket — no notification, favicon badge
 * or title count arrives while the panel is up.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /**
   * Builds the boundary in its healthy state.
   *
   * @param props - Component props.
   */
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { message: null, path: null };
  }

  /**
   * Turns a thrown value into the state that renders the failure.
   *
   * @param error - Value thrown below the boundary.
   * @returns The next state.
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: wordsOf(error), path: window.location.pathname };
  }

  /**
   * Starts listening for the navigation that clears the failure.
   *
   * @returns Nothing.
   */
  override componentDidMount(): void {
    window.addEventListener('popstate', this.onNavigate);
    window.addEventListener(NAVIGATE_EVENT, this.onNavigate);
  }

  /**
   * Stops listening for navigation.
   *
   * @returns Nothing.
   */
  override componentWillUnmount(): void {
    window.removeEventListener('popstate', this.onNavigate);
    window.removeEventListener(NAVIGATE_EVENT, this.onNavigate);
  }

  /**
   * Reports the failure to the console, where the stack is readable.
   *
   * @param error - Value thrown below the boundary.
   * @param info - React's component stack for the throw.
   * @returns Nothing.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only place a caught throw is recorded, so it carries
    // the route it happened on — a session id is in the pathname, and without
    // it a report from a long-lived tab names no session at all.
    console.error(
      `the dashboard stopped rendering on ${window.location.pathname}`,
      error,
      info.componentStack,
    );
  }

  /**
   * Renders the tree, or the failure that replaced it.
   *
   * @returns The children, or the failure panel.
   */
  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;
    const fallback = this.props.fallback;
    if (fallback !== undefined) return fallback(message, this.retry);
    return this.renderFailure(message);
  }

  /**
   * Clears the failure so the tree below is mounted again.
   *
   * @returns Nothing.
   */
  private readonly retry = (): void => {
    this.setState({ message: null, path: null });
  };

  /**
   * Clears a failure the owner has navigated away from.
   *
   * A throw belongs to the route it happened on. Leaving that route is the
   * owner asking for a different tree, and the one they left is not the one
   * that would be rendered.
   *
   * @returns Nothing.
   */
  private readonly onNavigate = (): void => {
    if (this.state.message === null) return;
    if (window.location.pathname === this.state.path) return;
    this.retry();
  };

  /**
   * Renders the whole-dashboard failure panel.
   *
   * @param message - Message of the error that unmounted the tree.
   * @returns The panel element.
   */
  private renderFailure(message: string): JSX.Element {
    return (
      <div className="app">
        <p className="banner" role="alert">
          The dashboard stopped rendering: {message}
        </p>
        <p className="empty">
          The sessions themselves are unaffected — they run in tmux, not in this page. This page has
          stopped listening for their events until it renders again.
        </p>
        <div className="boundary-actions">
          <button type="button" className="btn btn-primary" onClick={this.retry}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the dashboard
          </button>
        </div>
      </div>
    );
  }
}
