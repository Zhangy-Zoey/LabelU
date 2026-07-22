import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

const ua = navigator.userAgent
document.body.classList.add(
  /Windows/i.test(ua) ? 'platform-win' : /Mac OS X|Macintosh/i.test(ua) ? 'platform-mac' : 'platform-other'
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
