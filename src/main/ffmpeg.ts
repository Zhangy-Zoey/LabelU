import { spawn, execFileSync, type ChildProcess } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { CropRect } from '../shared/types'
import { IMAGE_EXTENSIONS } from '../shared/types'
import {
  sanitizeName,
  sourceStemForExport,
  formatClipExportFileName,
  parseClipExportIndex,
  isMeaningfulCrop
} from '../shared/utils'
import { exportRootDirFor, resolveClassifyDestDir, type ClassifyDestOptions } from './exportPaths'

function isImageMediaPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/** 当前 ffmpeg/ffprobe 子进程集合，供取消时整树强杀 */
const activeChildren = new Set<ChildProcess>()
let cancelChecker: (() => boolean) | null = null

export function setFfmpegCancelChecker(fn: (() => boolean) | null): void {
  cancelChecker = fn
}

/** Windows 上 kill() 不一定带走子进程树，用 taskkill /T */
function killChildTree(child: ChildProcess): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      return
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

export function killActiveFfmpeg(): void {
  const list: ChildProcess[] = []
  activeChildren.forEach((c) => list.push(c))
  activeChildren.clear()
  for (const child of list) killChildTree(child)
}

export function toMediaUrl(filePath: string): string {
  return 'media://abs/' + encodeURIComponent(path.resolve(filePath))
}

function which(cmd: string): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [cmd], {
        encoding: 'utf8',
        windowsHide: true
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean)
      return out || null
    }
    const out = execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], {
      encoding: 'utf8'
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function resolveBinary(binPath: string | null | undefined): string | null {
  if (!binPath) return null
  let p = binPath
  if (p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked')
  }
  try {
    const st = fs.statSync(p)
    // 损坏/未下完的静态包往往只有几百 KB
    if (!st.isFile() || st.size < 1_000_000) return null
    return p
  } catch {
    return null
  }
}

function resourcesBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  // 安装包：extraResources → resources/bin/
  const packaged = resolveBinary(path.join(process.resourcesPath, 'bin', exe))
  if (packaged) return packaged
  // 开发：scripts/prepare-binaries.js 产出（相对 out/main）
  if (!app.isPackaged) {
    const plat = process.platform
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return resolveBinary(path.join(__dirname, '..', '..', 'build', 'bin', `${plat}-${arch}`, exe))
  }
  return null
}

function pickBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const bundled: string[] = []
  const fromResources = resourcesBin(name)
  if (fromResources) bundled.push(fromResources)

  // 开发态：回退到 npm 静态包（宿主平台）
  try {
    if (name === 'ffmpeg') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = resolveBinary(require('ffmpeg-static'))
      if (p) bundled.push(p)
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = resolveBinary(require('ffprobe-static').path)
      if (p) bundled.push(p)
    }
  } catch {
    /* ignore */
  }

  const candidates: (string | null)[] = [
    ...bundled,
    which(name),
    process.platform === 'darwin' ? `/opt/homebrew/bin/${name}` : null,
    process.platform === 'darwin' ? `/usr/local/bin/${name}` : null
  ]

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c
    }
  }

  throw new Error(
    process.platform === 'win32'
      ? `找不到可用的 ${name}。请重新安装本应用，或将 ${name}.exe 加入 PATH。`
      : `找不到可用的 ${name}。请执行：brew install ffmpeg，或重新 npm install。`
  )
}

let ffmpeg = ''
let ffprobe = ''

function ensureBins(): { ffmpeg: string; ffprobe: string } {
  if (!ffmpeg) ffmpeg = pickBinary('ffmpeg')
  if (!ffprobe) ffprobe = pickBinary('ffprobe')
  return { ffmpeg, ffprobe }
}

interface ProbeInfo {
  duration: number
  width: number
  height: number
  hasAudio: boolean
  isVfr: boolean
  rotation: number
  /** 有效帧率，用于时间轴按帧吸附 */
  fps: number
  /** ffprobe 视频编码名，如 hevc / h264 */
  videoCodec: string
  /** Windows Chromium 等环境下需转码预览 */
  needsPreviewProxy: boolean
}

/**
 * Chromium 对 HEVC 支持因平台而异：
 * - Windows：几乎总要 H.264 代理
 * - macOS：优先系统解码；播失败时由调用方 force 再生成代理
 */
function codecNeedsPreviewProxy(codecName: string | undefined | null): boolean {
  if (!codecName) return false
  const c = codecName.toLowerCase()
  if (!(c.includes('hevc') || c.includes('h265') || c.includes('hev1') || c.includes('hvc1'))) {
    return false
  }
  return process.platform === 'win32'
}

/**
 * 有限并发：Win 多路 HEVC 代理可并行（默认 2），又避免无限 spawn。
 * activeChildren 跟踪全部子进程，取消时可整树杀掉。
 */
const FFMPEG_MAX_CONCURRENT = process.platform === 'win32' ? 2 : 2
let ffmpegInFlight = 0
const ffmpegWaiters: Array<() => void> = []

function acquireFfmpegSlot(): Promise<void> {
  if (ffmpegInFlight < FFMPEG_MAX_CONCURRENT) {
    ffmpegInFlight++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    ffmpegWaiters.push(() => {
      ffmpegInFlight++
      resolve()
    })
  })
}

function releaseFfmpegSlot(): void {
  ffmpegInFlight = Math.max(0, ffmpegInFlight - 1)
  const next = ffmpegWaiters.shift()
  if (next) next()
}

async function run(
  bin: string,
  args: string[],
  onProgress?: (line: string) => void,
  timeoutMs = 600_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  await acquireFfmpegSlot()
  try {
    return await runOnce(bin, args, onProgress, timeoutMs)
  } finally {
    releaseFfmpegSlot()
  }
}

function runOnce(
  bin: string,
  args: string[],
  onProgress?: (line: string) => void,
  timeoutMs = 600_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (cancelChecker?.()) {
      reject(new Error('已取消'))
      return
    }
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      killChildTree(child)
      finish(() => reject(new Error(`FFmpeg 超时（>${Math.round(timeoutMs / 1000)}s）: ${bin}`)))
    }, timeoutMs)

    const cancelPoll = setInterval(() => {
      if (cancelChecker?.()) killChildTree(child)
    }, 200)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(cancelPoll)
      activeChildren.delete(child)
      fn()
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      const text = d.toString()
      stderr += text
      onProgress?.(text)
    })
    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动 ${bin}: ${err.message}`)))
    })
    child.on('close', (code) => {
      finish(() => {
        if (cancelChecker?.()) {
          reject(new Error('已取消'))
          return
        }
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
  })
}

const probeCache = new Map<string, { mtime: number; info: ProbeInfo }>()

function probeCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function probeVideo(filePath: string): Promise<ProbeInfo> {
  let mtime = 0
  const cacheKey = probeCacheKey(filePath)
  try {
    mtime = fs.statSync(filePath).mtimeMs
    const hit = probeCache.get(cacheKey)
    if (hit && hit.mtime === mtime) return hit.info
  } catch {
    /* continue */
  }

  const { ffprobe } = ensureBins()
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ]
  const { code, stdout } = await run(ffprobe, args)
  if (code !== 0) throw new Error(`无法读取视频信息: ${filePath}`)
  const data = JSON.parse(stdout)
  const videoStream = (data.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video')
  const audioStream = (data.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio')
  const duration = parseFloat(data.format?.duration || videoStream?.duration || '0') || 0
  let width = videoStream?.width || 0
  let height = videoStream?.height || 0
  let rotation = 0
  const tags = videoStream?.tags || {}
  if (tags.rotate) rotation = parseInt(tags.rotate, 10) || 0
  const sideData = videoStream?.side_data_list || []
  for (const sd of sideData) {
    if (sd.rotation != null) rotation = parseInt(String(sd.rotation), 10) || rotation
  }
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
    ;[width, height] = [height, width]
  }
  const avgRate = videoStream?.avg_frame_rate || '0/0'
  const rRate = videoStream?.r_frame_rate || '0/0'
  const isVfr = avgRate !== rRate && avgRate !== '0/0' && rRate !== '0/0'
  const fps = parseFrameRate(avgRate !== '0/0' ? avgRate : rRate)
  const videoCodec = String(videoStream?.codec_name || '').trim()
  const info: ProbeInfo = {
    duration,
    width,
    height,
    hasAudio: Boolean(audioStream),
    isVfr,
    rotation,
    fps,
    videoCodec,
    needsPreviewProxy: codecNeedsPreviewProxy(videoCodec)
  }
  probeCache.set(cacheKey, { mtime, info })
  return info
}

function parseFrameRate(rate: string): number {
  if (!rate || rate === '0/0' || rate === 'N/A') return 25
  if (rate.includes('/')) {
    const [a, b] = rate.split('/').map((x) => Number(x))
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
      const fps = a / b
      if (fps > 1 && fps <= 240) return fps
    }
    return 25
  }
  const n = Number(rate)
  return Number.isFinite(n) && n > 1 && n <= 240 ? n : 25
}

function cropFilter(crop: CropRect, width: number, height: number): string {
  const x = Math.max(0, Math.round(crop.x * width))
  const y = Math.max(0, Math.round(crop.y * height))
  let w = Math.max(2, Math.round(crop.width * width))
  let h = Math.max(2, Math.round(crop.height * height))
  // even dimensions for yuv420
  w = w - (w % 2)
  h = h - (h % 2)
  const safeW = Math.min(w, width - x - ((width - x) % 2))
  const safeH = Math.min(h, height - y - ((height - y) % 2))
  return `crop=${safeW}:${safeH}:${x}:${y}`
}

/** 流拷贝裁切：秒级完成，优先使用 */
async function tryCopyCut(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string
): Promise<boolean> {
  const duration = end - start
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(start),
    '-i',
    sourcePath,
    '-t',
    String(duration),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    outputPath
  ]
  const { code } = await run(ffmpeg, args, undefined, 120_000)
  if (code !== 0) return false
  try {
    const st = fs.statSync(outputPath)
    return st.size > 1024
  } catch {
    return false
  }
}

type VideoEncodeMode = 'videotoolbox' | 'libx264'

let cachedEncodeMode: VideoEncodeMode | null = null

async function resolveEncodeMode(): Promise<VideoEncodeMode> {
  if (cachedEncodeMode) return cachedEncodeMode
  if (process.platform === 'darwin') {
    cachedEncodeMode = 'videotoolbox'
    return cachedEncodeMode
  }
  cachedEncodeMode = 'libx264'
  return cachedEncodeMode
}

function pushVideoEncodeArgs(args: string[], mode: VideoEncodeMode): void {
  if (mode === 'videotoolbox') {
    args.push('-c:v', 'h264_videotoolbox', '-b:v', '8M', '-allow_sw', '1')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
  }
}

async function reencodeCut(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string,
  crop: CropRect | null,
  probe: ProbeInfo,
  mode: VideoEncodeMode
): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-ss',
    String(start),
    '-to',
    String(end)
  ]
  if (crop) {
    args.push('-vf', cropFilter(crop, probe.width, probe.height))
  }
  pushVideoEncodeArgs(args, mode)
  if (mode === 'videotoolbox') {
    args.push('-pix_fmt', 'yuv420p')
  }
  if (probe.hasAudio) {
    args.push('-map', '0:v:0', '-map', '0:a?', '-c:a', 'copy')
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart', outputPath)
  const { code, stderr } = await run(ffmpeg, args, undefined, 600_000)
  if (code !== 0) {
    throw new Error(stderr.slice(-500) || '重编码失败')
  }
}

export async function exportClip(options: {
  sourcePath: string
  start: number
  end: number
  outputPath: string
  crop: CropRect | null
  cropActive: boolean
  forceReencode?: boolean
}): Promise<{ usedReencode: boolean; message?: string }> {
  ensureBins()
  const probe = await probeVideo(options.sourcePath)
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })

  // 无画面裁切时优先流拷贝（含 VFR）；Mac 上流拷贝易片头黑屏，直接重编码
  if (!options.forceReencode && !options.cropActive && process.platform !== 'darwin') {
    const ok = await tryCopyCut(options.sourcePath, options.start, options.end, options.outputPath)
    if (ok) {
      return { usedReencode: false }
    }
  }

  let mode = await resolveEncodeMode()
  try {
    await reencodeCut(
      options.sourcePath,
      options.start,
      options.end,
      options.outputPath,
      options.cropActive ? options.crop : null,
      probe,
      mode
    )
    return {
      usedReencode: true,
      message: mode === 'videotoolbox' ? '已使用硬件加速导出' : undefined
    }
  } catch (err) {
    // 音频 copy 失败（如裁切后时间戳问题）时：改 AAC；硬件失败则回退软件
    const mustSoft = mode === 'videotoolbox'
    if (mustSoft) cachedEncodeMode = 'libx264'
    mode = 'libx264'

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      options.sourcePath,
      '-ss',
      String(options.start),
      '-to',
      String(options.end)
    ]
    if (options.cropActive && options.crop) {
      args.push('-vf', cropFilter(options.crop, probe.width, probe.height))
    }
    pushVideoEncodeArgs(args, 'libx264')
    if (probe.hasAudio) {
      args.push('-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k')
    } else {
      args.push('-an')
    }
    args.push('-movflags', '+faststart', options.outputPath)
    const { code, stderr } = await run(ffmpeg, args, undefined, 600_000)
    if (code !== 0) {
      throw new Error(`导出失败: ${stderr.slice(-500) || (err instanceof Error ? err.message : String(err))}`)
    }
    return { usedReencode: true, message: '已使用快速软件编码导出' }
  }
}

/** 图片裁切导出使用的扩展名（尽量保留无损/透明） */
export function preferredImageExportExt(sourcePath: string): string {
  const ext = path.extname(sourcePath).toLowerCase()
  if (ext === '.png') return '.png'
  if (ext === '.webp') return '.webp'
  if (ext === '.jpg' || ext === '.jpeg') return '.jpg'
  return '.jpg'
}

export async function nextExportPath(
  sourcePath: string,
  category: string,
  range: { start: number; end: number },
  crop?: CropRect | null,
  fileExt = '.mp4',
  opts?: ClassifyDestOptions
): Promise<string> {
  const cat = sanitizeName(category)
  if (!cat) throw new Error('类别名无效')

  // 落点与整片归类同一套规则；custom 时直接写入所选最终目录（不套类别名）
  const categoryDir = resolveClassifyDestDir(sourcePath, cat, opts)
  const mode = opts?.reclassifyMode ?? 'originalRoot'
  const customFinal = mode === 'custom'

  if (!customFinal) {
    const root = path.dirname(categoryDir)
    const resolvedRoot = path.resolve(root)
    const resolvedCat = path.resolve(categoryDir)
    const catOk =
      process.platform === 'win32'
        ? resolvedCat.toLowerCase() === resolvedRoot.toLowerCase() ||
          resolvedCat.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep)
        : resolvedCat === resolvedRoot || resolvedCat.startsWith(resolvedRoot + path.sep)
    if (!catOk) {
      throw new Error('类别名无效')
    }
  }

  fs.mkdirSync(categoryDir, { recursive: true })

  // 文件名前缀仍按「导出根目录名_源文件名」，便于回看匹配
  const namingRoot = exportRootDirFor(sourcePath)
  const parentDirName = sanitizeName(path.basename(namingRoot))
  const stem = sanitizeName(sourceStemForExport(sourcePath))
  const ext = fileExt.startsWith('.') ? fileExt.toLowerCase() : `.${fileExt.toLowerCase()}`
  const prefix = `${parentDirName}_${stem}_`
  let max = 0
  for (const name of fs.readdirSync(categoryDir)) {
    if (!name.startsWith(prefix)) continue
    const n = parseClipExportIndex(name, prefix)
    if (n != null) max = Math.max(max, n)
  }
  return path.join(
    categoryDir,
    formatClipExportFileName(prefix, max + 1, category, range.start, range.end, crop, ext)
  )
}

/** 图片裁切保存（无裁切时尽量原样复制） */
export async function exportImageCrop(options: {
  sourcePath: string
  outputPath: string
  crop: CropRect | null
  cropActive: boolean
}): Promise<{ message?: string }> {
  ensureBins()
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })

  const outExt = path.extname(options.outputPath).toLowerCase()
  const srcExt = path.extname(options.sourcePath).toLowerCase()
  const needCrop = options.cropActive && options.crop && isMeaningfulCrop(options.crop)

  if (!needCrop && outExt === srcExt) {
    await fs.promises.copyFile(options.sourcePath, options.outputPath)
    return { message: '已保存原图到类别目录' }
  }

  const probe = await probeVideo(options.sourcePath)
  if (!(probe.width > 0) || !(probe.height > 0)) {
    throw new Error('无法读取图片尺寸')
  }

  const { ffmpeg: bin } = ensureBins()
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.sourcePath]
  if (needCrop && options.crop) {
    args.push('-vf', cropFilter(options.crop, probe.width, probe.height))
  }
  args.push('-frames:v', '1')
  if (outExt === '.png') {
    args.push('-compression_level', '6')
  } else if (outExt === '.webp') {
    args.push('-q:v', '85')
  } else {
    args.push('-q:v', '2')
  }
  args.push(options.outputPath)

  const { code, stderr } = await run(bin, args, undefined, 120_000)
  if (code !== 0) {
    throw new Error(stderr.slice(-500) || '图片导出失败')
  }
  try {
    if (!fs.existsSync(options.outputPath) || fs.statSync(options.outputPath).size < 32) {
      throw new Error('图片导出失败：输出无效')
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
  return { message: needCrop ? '已裁切保存图片' : '已保存图片到类别目录' }
}

/** 生成并缓存缩略图，返回 media:// URL（缓存键含 mtime） */
export async function generateThumbnail(videoPath: string): Promise<string> {
  const cacheDir = path.join(app.getPath('userData'), 'thumbnails')
  fs.mkdirSync(cacheDir, { recursive: true })
  let mtime = 0
  try {
    mtime = fs.statSync(videoPath).mtimeMs
  } catch {
    throw new Error('文件不存在')
  }
  const cacheKey =
    process.platform === 'win32' ? path.resolve(videoPath).toLowerCase() : path.resolve(videoPath)
  const hash = crypto.createHash('md5').update(`${cacheKey}|${mtime}`).digest('hex')
  const out = path.join(cacheDir, `${hash}.jpg`)
  if (fs.existsSync(out) && fs.statSync(out).size > 100) {
    return toMediaUrl(out)
  }

  const { ffmpeg: bin } = ensureBins()
  // 保持 .jpg 扩展名，避免 Windows 上 FFmpeg 无法识别封装
  const tmp = path.join(cacheDir, `${hash}.tmp.jpg`)
  const isImage = isImageMediaPath(videoPath)
  const scale = "scale='min(480,iw)':-2"
  /** 多组参数：HEVC/损坏时间戳在 Win 上对 -ss 位置敏感 */
  const attemptArgs: string[][] = isImage
    ? [['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '5', '-vf', scale, '-f', 'image2', tmp]]
    : [
        ['-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-an', '-q:v', '5', '-vf', scale, '-f', 'image2', tmp],
        ['-y', '-i', videoPath, '-ss', '0', '-frames:v', '1', '-an', '-q:v', '5', '-vf', scale, '-f', 'image2', tmp],
        ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-an', '-q:v', '5', '-vf', scale, '-f', 'image2', tmp]
      ]

  let lastErr = ''
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  } catch {
    /* ignore */
  }

  for (const args of attemptArgs) {
    try {
      const result = await run(bin, args, undefined, 60_000)
      if (result.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size >= 100) {
        try {
          fs.renameSync(tmp, out)
        } catch {
          fs.copyFileSync(tmp, out)
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
        return toMediaUrl(out)
      }
      lastErr = result.stderr.slice(-400) || `code=${result.code}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  throw new Error(lastErr || '缩略图生成失败')
}

const previewProxyInFlight = new Map<string, Promise<{ path: string; proxied: boolean }>>()

/**
 * 为 Chromium 难以直出的编码生成 H.264 预览代理。
 * Windows 对 HEVC 默认需要；macOS 优先原片，force 时仍可生成（播失败回退）。
 */
export async function ensurePreviewProxy(
  sourcePath: string,
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<{ path: string; proxied: boolean }> {
  const abs = path.resolve(sourcePath)
  if (!fs.existsSync(abs)) throw new Error('源视频不存在')
  if (isImageMediaPath(abs)) return { path: abs, proxied: false }

  const probe = await probeVideo(abs)
  const need = opts?.force || probe.needsPreviewProxy
  if (!need) return { path: abs, proxied: false }

  const cacheDir = path.join(app.getPath('userData'), 'preview-proxy')
  fs.mkdirSync(cacheDir, { recursive: true })
  let mtime = 0
  try {
    mtime = fs.statSync(abs).mtimeMs
  } catch {
    throw new Error('源视频不存在')
  }
  const cacheKey =
    process.platform === 'win32' ? abs.toLowerCase() : abs
  // v3：临时文件必须为 *.part.mp4（勿用 *.mp4.part，Windows FFmpeg 无法识别 muxer）
  const hash = crypto.createHash('md5').update(`${cacheKey}|${mtime}|v3`).digest('hex')
  const out = path.join(cacheDir, `${hash}.mp4`)
  const flightKey = `${cacheKey}|${mtime}|v3|${opts?.force ? '1' : '0'}`

  if (!opts?.force && fs.existsSync(out) && fs.statSync(out).size > 1024) {
    return { path: out, proxied: true }
  }

  const existing = previewProxyInFlight.get(flightKey)
  if (existing) return existing

  const job = buildPreviewProxy(abs, out, opts)
  previewProxyInFlight.set(flightKey, job)
  try {
    return await job
  } finally {
    previewProxyInFlight.delete(flightKey)
  }
}

async function buildPreviewProxy(
  abs: string,
  out: string,
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<{ path: string; proxied: boolean }> {
  if (opts?.force) {
    try {
      if (fs.existsSync(out)) fs.unlinkSync(out)
    } catch {
      /* ignore */
    }
  } else if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    return { path: out, proxied: true }
  }

  opts?.onProgress?.('正在生成兼容预览（HEVC→H.264）…')
  const { ffmpeg: bin } = ensureBins()
  // 扩展名必须以 .mp4 结尾；`.mp4.part` 在 Windows 上会报 Invalid argument / muxer 初始化失败
  const stem = path.basename(out, '.mp4')
  const tmp = path.join(path.dirname(out), `${stem}.part.mp4`)
  const legacyTmp = path.join(path.dirname(out), `${stem}.mp4.part`)
  for (const p of [tmp, legacyTmp]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }

  const runProxy = async (withAudio: boolean): Promise<{ code: number; stderr: string }> => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      abs,
      '-map',
      '0:v:0',
      ...(withAudio ? ['-map', '0:a?'] : ['-an']),
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      tmp
    ]
    return run(bin, args, undefined, 1_800_000)
  }

  let { code, stderr } = await runProxy(true)
  if (code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    // 部分素材音频轨异常：无声再试一次仍可预览画面
    ;({ code, stderr } = await runProxy(false))
  }

  if (code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw new Error(stderr.slice(-500) || '兼容预览生成失败')
  }
  try {
    fs.renameSync(tmp, out)
  } catch {
    fs.copyFileSync(tmp, out)
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  return { path: out, proxied: true }
}
