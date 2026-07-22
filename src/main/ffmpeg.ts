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
import { exportRootDirFor } from './exportPaths'

function isImageMediaPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/** 当前 ffmpeg/ffprobe 子进程，供取消时强杀 */
let activeChild: ChildProcess | null = null
let cancelChecker: (() => boolean) | null = null

export function setFfmpegCancelChecker(fn: (() => boolean) | null): void {
  cancelChecker = fn
}

export function killActiveFfmpeg(): void {
  const child = activeChild
  activeChild = null
  if (!child) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
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
      console.log(`[labelu] using ${name}:`, c)
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

export interface ProbeInfo {
  duration: number
  width: number
  height: number
  hasAudio: boolean
  isVfr: boolean
  rotation: number
  /** 有效帧率，用于时间轴按帧吸附 */
  fps: number
}

function run(
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
    activeChild = child
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error(`FFmpeg 超时（>${Math.round(timeoutMs / 1000)}s）: ${bin}`)))
    }, timeoutMs)

    const cancelPoll = setInterval(() => {
      if (cancelChecker?.()) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 200)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(cancelPoll)
      if (activeChild === child) activeChild = null
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
  const info: ProbeInfo = {
    duration,
    width,
    height,
    hasAudio: Boolean(audioStream),
    isVfr,
    rotation,
    fps
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
  fileExt = '.mp4'
): Promise<string> {
  // 已在类别目录内时，导出到上一级（与同批源片的类别文件夹并列），避免嵌套
  const dirPath = exportRootDirFor(sourcePath)
  const parentDirName = sanitizeName(path.basename(dirPath))
  const stem = sanitizeName(sourceStemForExport(sourcePath))
  const categoryDir = path.join(dirPath, sanitizeName(category))
  const resolvedDir = path.resolve(dirPath)
  const resolvedCat = path.resolve(categoryDir)
  const catOk =
    process.platform === 'win32'
      ? resolvedCat.toLowerCase() === resolvedDir.toLowerCase() ||
        resolvedCat.toLowerCase().startsWith(resolvedDir.toLowerCase() + path.sep)
      : resolvedCat === resolvedDir || resolvedCat.startsWith(resolvedDir + path.sep)
  if (!catOk) {
    throw new Error('类别名无效')
  }
  fs.mkdirSync(categoryDir, { recursive: true })

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
  const tmp = `${out}.tmp.jpg`
  const isImage = isImageMediaPath(videoPath)
  try {
    const args = isImage
      ? ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '5', '-vf', 'scale=480:-1', tmp]
      : [
          '-y',
          '-ss',
          '0.5',
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-q:v',
          '5',
          '-vf',
          'scale=480:-1',
          tmp
        ]
    const result = await run(bin, args, undefined, 45_000)
    if (result.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 100) {
      throw new Error(result.stderr.slice(-400) || '缩略图生成失败')
    }
    fs.renameSync(tmp, out)
    return toMediaUrl(out)
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}
