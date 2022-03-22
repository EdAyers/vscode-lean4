import React from 'react';

export class ErrorBoundary extends React.Component<{}, {error: string | undefined}> {
  constructor(props: {}) {
    super(props);
    this.state = { error: undefined };
  }

  static getDerivedStateFromError(error: any) {
    // Update state so the next render will show the fallback UI.
    return { error: error.toString() };
  }

  render() {
    if (this.state.error) {
      // You can render any custom fallback UI
      return <h1>{this.state.error}</h1>;
    }

    return this.props.children;
  }
}

