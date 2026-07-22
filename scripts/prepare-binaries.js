/**
 * 按目标平台准备 ffmpeg/ffprobe 到 build/bin/<platform>-<arch>/，
 * 供 electron-builder extraResources 打进安装包（避免跨平台打包打进宿主二进制）。
 *
 * 用法:
 *   node scripts/prepare-binaries.js win32 x64
 *   node scripts/prepare-binaries.js darwin arm64
 */
const fs = require('fs')
const path = require('path')
const { gunzipSync } = require('zlib')
const https = require('https')

const FFMPEG_TAG = 'b6.1.1'
const ROOT = path.join(__dirname, '..')

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
    const req = https.get(url, { timeout: 300000 }, (res) => {
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

async function downloadGzBinary(kind, platform, arch, destFile) {
  if (isValidBinary(destFile)) {
    chmodx(destFile)
    console.log(`${kind} ok:`, destFile)
    return
  }
  // 官方资源名：ffmpeg-win32-x64.gz / ffprobe-darwin-arm64.gz（Windows 也无 .exe 后缀）
  const name = `${kind}-${platform}-${arch}.gz`
  const mirrors = [
    `https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${name}`,
    `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${name}`
  ]
  let lastErr
  for (const url of mirrors) {
    try {
      console.log(`downloading ${kind}:`, url)
      const buf = await download(url)
      const out = gunzipSync(buf)
      fs.mkdirSync(path.dirname(destFile), { recursive: true })
      fs.writeFileSync(destFile, out)
      chmodx(destFile)
      if (!isValidBinary(destFile)) throw new Error(`downloaded ${kind} too small`)
      console.log(`${kind} ready:`, destFile, fs.statSync(destFile).size)
      return
    } catch (e) {
      lastErr = e
      console.warn('mirror failed:', e.message)
    }
  }
  throw lastErr || new Error(`${kind} download failed`)
}

function copyFfprobeFallback(platform, arch, destFile) {
  const srcName = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const src = path.join(
    ROOT,
    'node_modules',
    'ffprobe-static',
    'bin',
    platform,
    arch,
    srcName
  )
  if (!isValidBinary(src)) {
    throw new Error(`missing ffprobe-static binary: ${src}`)
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.copyFileSync(src, destFile)
  chmodx(destFile)
  console.log('ffprobe ready (from ffprobe-static):', destFile, fs.statSync(destFile).size)
}

async function main() {
  const platform = process.argv[2] || process.platform
  const arch = process.argv[3] || (process.arch === 'arm64' ? 'arm64' : 'x64')
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`)
  }
  if (!['x64', 'arm64', 'ia32'].includes(arch)) {
    throw new Error(`unsupported arch: ${arch}`)
  }

  const outDir = path.join(ROOT, 'build', 'bin', `${platform}-${arch}`)
  fs.mkdirSync(outDir, { recursive: true })

  const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffprobeName = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

  await downloadGzBinary('ffmpeg', platform, arch, path.join(outDir, ffmpegName))
  try {
    await downloadGzBinary('ffprobe', platform, arch, path.join(outDir, ffprobeName))
  } catch (e) {
    console.warn('ffprobe download failed, fallback to ffprobe-static:', e.message)
    copyFfprobeFallback(platform, arch, path.join(outDir, ffprobeName))
  }
  console.log('prepared binaries in', outDir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
