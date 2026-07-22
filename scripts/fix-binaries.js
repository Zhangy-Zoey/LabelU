const fs = require('fs')
const path = require('path')
const { gunzipSync } = require('zlib')
const https = require('https')

function chmodx(p) {
  try {
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755)
  } catch {
    /* ignore */
  }
}

function isValidBinary(p, minSize = 1_000_000) {
  try {
    const st = fs.statSync(p)
    return st.isFile() && st.size >= minSize
  } catch {
    return false
  }
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 180000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('download timeout'))
    })
  })
}

async function ensureFfmpegStatic() {
  let target
  try {
    target = require('ffmpeg-static')
  } catch {
    return
  }
  if (!target) return
  if (isValidBinary(target)) {
    chmodx(target)
    console.log('ffmpeg-static ok:', target)
    return
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const name = `ffmpeg-${platform}-${arch}.gz`
  const mirrors = [
    `https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${name}`,
    `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${name}`
  ]

  for (const url of mirrors) {
    try {
      console.log('downloading ffmpeg from', url)
      const buf = await download(url)
      const out = gunzipSync(buf)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, out)
      chmodx(target)
      if (isValidBinary(target)) {
        console.log('ffmpeg-static repaired:', target, fs.statSync(target).size)
        return
      }
    } catch (e) {
      console.warn('mirror failed:', e.message)
    }
  }
  console.warn('ffmpeg-static not repaired; will fall back to system ffmpeg if available')
}

async function main() {
  try {
    const ffmpeg = require('ffmpeg-static')
    if (ffmpeg) chmodx(ffmpeg)
  } catch {
    /* ignore */
  }
  try {
    const ffprobe = require('ffprobe-static').path
    if (ffprobe) chmodx(ffprobe)
  } catch {
    /* ignore */
  }

  const root = path.join(__dirname, '..', 'node_modules', 'ffprobe-static', 'bin')
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name === 'ffprobe' || name === 'ffprobe.exe') chmodx(p)
    }
  }
  walk(root)

  await ensureFfmpegStatic()
  console.log('binaries permissions fixed')
}

main().catch((e) => {
  console.warn(e)
  process.exit(0)
})
