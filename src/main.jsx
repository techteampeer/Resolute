import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Which build is the browser actually running? Logged so a stale bundle is
// diagnosable in one glance instead of guessing at caches, and exposed on
// <html data-build> for scripted checks.
console.info(`Resolute Portal · build ${__BUILD_COMMIT__} · ${__BUILD_TIME__}`)
document.documentElement.dataset.build = __BUILD_COMMIT__

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
