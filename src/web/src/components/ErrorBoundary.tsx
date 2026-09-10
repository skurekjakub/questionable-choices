import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

/**
 * Props of {@link ErrorBoundary}.
 */
export interface ErrorBoundaryProps {
  /** Tree to render while nothing has thrown. */
  children: ReactNode;
}

/**
 * State of {@link ErrorBoundary}.
 */
export interface ErrorBoundaryState {
  /** Message of the error that unmounted the tree, or null while it is healthy. */
  message: string | null;
}

/**
 * Catches a throw from anywhere below it and shows what happened instead of a
 * blank page.
 *
 * A dashboard whose job is to tell the owner that something needs them must not
 * answer a thrown render or effect with an empty document; the message and the
 * reload are the minimum that keeps the failure legible.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /**
   * Builds the boundary in its healthy state.
   *
   * @param props - Component props.
   */
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { message: null };
  }

  /**
   * Turns a thrown value into the state that renders the failure.
   *
   * @param error - Value thrown below the boundary.
   * @returns The next state.
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  /**
   * Reports the failure to the console, where the stack is readable.
   *
   * @param error - Value thrown below the boundary.
   * @param info - React's component stack for the throw.
   * @returns Nothing.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('the dashboard stopped rendering', error, info.componentStack);
  }

  /**
   * Renders the tree, or the failure that replaced it.
   *
   * @returns The children, or the failure panel.
   */
  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;
    return this.renderFailure(message);
  }

  /**
   * Renders the failure panel.
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
          The sessions themselves are unaffected — they run in tmux, not in this page.
        </p>
        <div className="boundary-actions">
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the dashboard
          </button>
        </div>
      </div>
    );
  }
}
