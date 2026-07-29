import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { crashed: boolean }

/** 渲染崩溃：静默上报整份 error 日志；用户只看到简短提示 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[labelu] render crash', error, info.componentStack)
    try {
      void window.api?.logClientError?.({
        tag: 'ErrorBoundary',
        message: error.message,
        stack: `${error.stack || ''}\n${info.componentStack || ''}`,
        forceMail: true
      })
    } catch {
      /* ignore */
    }
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.crashed && prevProps.children !== this.props.children) {
      this.setState({ crashed: false })
    }
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <div
          style={{
            padding: 24,
            color: '#fff',
            background: '#1a1a1a',
            minHeight: '100vh',
            fontFamily: 'system-ui, sans-serif',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'center',
            gap: 12
          }}
        >
          <h1 style={{ fontSize: 18, margin: 0 }}>出了点问题，已上报</h1>
          <p style={{ color: '#aaa', fontSize: 13, margin: 0 }}>请重新加载后再试。</p>
          <button
            type="button"
            style={{ padding: '8px 14px', cursor: 'pointer', marginTop: 8 }}
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
