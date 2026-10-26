import { Component, type ErrorInfo, type ReactNode } from "react";

export interface OpenUIErrorBoundaryProps {
  children: ReactNode;
  uiPath?: string | undefined;
  onEditUI?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
}

interface OpenUIErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class OpenUIErrorBoundary extends Component<
  OpenUIErrorBoundaryProps,
  OpenUIErrorBoundaryState
> {
  override state: OpenUIErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): OpenUIErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("OpenUI Render Error caught by boundary:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      const targetPath = this.props.uiPath ?? "ui.openui";
      return (
        <div
          aria-label="OpenUI render error"
          className="rounded-xl border border-error/30 bg-error/10 p-5 text-base-content space-y-3"
          role="alert"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-error font-semibold text-sm">
              <span className="badge badge-error badge-sm">
                OpenUI Render Error
              </span>
              <span>Failed to render {targetPath}</span>
            </div>
            {this.props.onEditUI && (
              <button
                className="btn btn-xs btn-outline btn-error"
                onClick={this.props.onEditUI}
                type="button"
              >
                Edit {targetPath}
              </button>
            )}
          </div>
          <p className="text-xs font-mono bg-base-300/80 p-3 rounded-lg overflow-x-auto text-error">
            {this.state.error?.message ??
              "An unexpected error occurred during OpenUI evaluation."}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              className="btn btn-xs btn-ghost text-xs"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                this.props.onReset?.();
              }}
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
