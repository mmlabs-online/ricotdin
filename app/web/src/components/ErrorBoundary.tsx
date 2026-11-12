import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorScreen } from './ErrorScreen'

type State = { failed: boolean }

/** Last line of defence: a render error shows a reload screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error service in the browser yet; the console is enough for development.
    console.error('render error', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? <ErrorScreen /> : this.props.children
  }
}
