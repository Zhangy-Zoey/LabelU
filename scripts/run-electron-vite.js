/**
 * Cross-platform launcher: clears ELECTRON_RUN_AS_NODE (injected by some IDEs)
 * then runs electron-vite with the remaining argv.
 */
delete process.env.ELECTRON_RUN_AS_NODE

const { spawn } = require('child_process')
const path = require('path')

const bin = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron-vite',
  'bin',
  'electron-vite.js'
)
const args = process.argv.slice(2)
const child = spawn(process.execPath, [bin, ...args], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
