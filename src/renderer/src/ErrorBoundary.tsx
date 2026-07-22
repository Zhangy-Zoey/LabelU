import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null; logPath: string | null }

/** 捕获渲染崩溃，避免白屏无提示 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, logPath: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[labelu] render crash', error, info.componentStack)
    try {
      void window.api
        ?.logClientError?.({
          tag: 'ErrorBoundary',
          message: error.message,
          stack: `${error.stack || ''}\n${info.componentStack || ''}`
        })
        .then((r) => {
          if (r?.logPath) this.setState({ logPath: r.logPath })
        })
    } catch {
      /* ignore */
    }
  }

  /** HMR / 子树更新后清掉旧崩溃态，避免一直卡在错误页 */
  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.children !== this.props.children) {
      this.setState({ error: null, logPath: null })
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: '#fff',
            background: '#1a1a1a',
            minHeight: '100vh',
            fontFamily: 'system-ui, sans-serif'
          }}
        >
          <h1 style={{ fontSize: 18, marginTop: 0 }}>界面加载失败</h1>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#f88',
              fontSize: 13
            }}
          >
            {this.state.error.message}
          </pre>
          {this.state.logPath ? (
            <p style={{ color: '#aaa', fontSize: 12 }}>异常已写入：{this.state.logPath}</p>
          ) : null}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              style={{ padding: '8px 14px', cursor: 'pointer' }}
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
            <button
              type="button"
              style={{ padding: '8px 14px', cursor: 'pointer' }}
              onClick={() => {
                void window.api
                  ?.openExceptionLog?.()
                  .then((r: { ok: boolean; path: string; error?: string }) => {
                    if (r && !r.ok && r.error) {
                      console.error('[labelu] openExceptionLog', r.error)
                    }
                  })
                  .catch((err: unknown) => console.error('[labelu] openExceptionLog', err))
              }}
            >
              查看日志
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
