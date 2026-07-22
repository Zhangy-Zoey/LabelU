import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  shell
} from 'electron'
import path, { join } from 'path'
import { Readable } from 'stream'
import fs from 'fs'
import { autoUpdater } from 'electron-updater'
import { scanPathsAsync, collectCategoryWhitelistPathsAsync, refreshCompletedFlags } from './scanner'
import {
  probeVideo,
  exportClip,
  exportImageCrop,
  preferredImageExportExt,
  nextExportPath,
  generateThumbnail,
  toMediaUrl,
  setFfmpegCancelChecker,
  killActiveFfmpeg
} from './ffmpeg'
import {
  saveSession,
  loadSession,
  loadWorkspaceSession,
  clearSession,
  clearSidecar,
  clipSidecarPath,
  listPendingSessions,
  discardSession,
  removeFromWorkspace,
  pushUndo,
  markCompleted,
  clearCompletedFlag,
  isCompleted,
  classifyWholeFileAsync,
  appendBatchClassifyUndo,
  clearBatchClassifyUndo,
  takeBatchClassifyUndo,
  restoreBatchClassifyUndo,
  undoBatchClassifyMoves,
  peekBatchClassifyUndo,
  initBatchUndoStore,
  beginCategoryScanCache,
  endCategoryScanCache,
  listCategoryDirectories,
  type BatchClassifyMove,
  type ClassifyDestOptions
} from './session'
import { exportRootDirFor } from './exportPaths'
import type {
  ExportRecord,
  ExportRequest,
  ImageExportRequest,
  SessionState,
  UndoEntry,
  VideoItem
} from '../shared/types'
import { IMAGE_TIMELINE_SECONDS, isImagePath } from '../shared/types'
import { computeRemainingFromExports, isMeaningfulCrop, totalDuration, validateClipSelection } from '../shared/utils'
import {
  applyCustomCategoryTags,
  getCustomCategoryTags,
  type ExtensibleGroupId
} from '../shared/categories'
import { appendLog, getLogDir, getExceptionLogPath, initLogger, logError } from './logger'
import { applyStartupVersionCheck, markWhatsNewSeen, type StartupVersionInfo } from './versionState'

/** 推算段仅供回看展示，不参与可剪剩余区 / 工作区持久化 */
function preciseExports(exports: ExportRecord[]): ExportRecord[] {
  return exports.filter((e) => !e.approx)
}

/** 开发时父进程/终端管道断开后，console 写入会抛 EIO/EPIPE 并变成 Uncaught Exception */
function ignoreBrokenStdio(): void {
  const swallow = (err: NodeJS.ErrnoException): void => {
    if (err?.code === 'EIO' || err?.code === 'EPIPE') return
    throw err
  }
  process.stdout?.on?.('error', swallow)
  process.stderr?.on?.('error', swallow)
  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EIO' || code === 'EPIPE') return
    const msg = String(err?.stack || err || '')
    // GPU / 网络服务偶发崩溃不应直接杀主进程，否则窗口一闪就没
    if (
      /GPU|gpu_process|network.?service|COMMAND_BUFFER|VizNull|SharedImage/i.test(msg)
    ) {
      try {
        process.stderr.write(`[labelu] ignored GPU/network fault: ${msg.slice(0, 300)}\n`)
      } catch {
        /* ignore */
      }
      appendLog('warn', 'gpu', msg.slice(0, 500))
      return
    }
    logError('uncaughtException', err)
    try {
      process.stderr.write(`[labelu] uncaughtException: ${msg}\n`)
    } catch {
      /* ignore */
    }
    // 非管道错误必须退出，否则会留下黑屏/空壳进程
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
    try {
      process.stderr.write(`[labelu] unhandledRejection: ${String(reason)}\n`)
    } catch {
      /* ignore */
    }
  })
}
ignoreBrokenStdio()

/**
 * 默认保留硬件加速：macOS 上 disableHardwareAcceleration 极易导致 <video> 黑屏无报错。
 * 若遇 GPU 崩溃无法启动，可设环境变量 LABELU_DISABLE_GPU=1 再开。
 */
if (process.env.LABELU_DISABLE_GPU === '1') {
  try {
    app.disableHardwareAcceleration()
  } catch {
    /* ignore */
  }
} else {
  // 软件合成下的视频更稳；不整站关 GPU
  try {
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  } catch {
    /* ignore */
  }
}

// 米家等监控视频多为 HEVC；开启平台解码，减少黑屏 / Unsupported pixel format: -1
try {
  app.commandLine.appendSwitch(
    'enable-features',
    'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport'
  )
  app.commandLine.appendSwitch('enable-accelerated-video-decode')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
} catch {
  /* ignore */
}

// Cursor/部分工具会注入 ELECTRON_RUN_AS_NODE=1，导致 require('electron') 变成二进制路径而非 API
if (process.env.ELECTRON_RUN_AS_NODE === '1' || typeof app?.whenReady !== 'function') {
  try {
    process.stderr.write(
      '[labelu] Electron API 不可用。请取消 ELECTRON_RUN_AS_NODE 后重试（npm run dev 已自动清除该变量）。\n'
    )
  } catch {
    /* ignore */
  }
  process.exit(1)
}

let busy = false
let busySince = 0
/** 用户请求中止当前长时间任务 */
let cancelRequested = false
let mainWindow: BrowserWindow | null = null
let allowQuit = false
/** 上次向渲染进程请求关闭的时间；短时间内再关则强制退出 */
let closeAskAt = 0
/**
 * 用户明确选过的媒体根路径（系统对话框 / 拖放 / 启动时会话恢复）。
 * 普通 scan-paths 只读已允许范围，不得靠渲染进程随便传路径扩权。
 */
const allowedRoots = new Set<string>()
let thumbQueue: Promise<void> = Promise.resolve()
let thumbActive = 0
const THUMB_MAX_CONCURRENT = 2

function rememberAllowedPath(p: string): void {
  try {
    const abs = pathResolveSafe(p)
    if (!abs) return
    allowedRoots.add(abs)
    allowedRoots.add(path.dirname(abs))
  } catch {
    /* ignore */
  }
}

/** 将用户明确选择的路径纳入白名单（不 existsSync，避免 Windows 杀软扫大文件卡死） */
function rememberUserMediaPaths(paths: string[]): void {
  for (const p of paths) {
    if (!p || typeof p !== 'string') continue
    try {
      const abs = pathResolveSafe(p)
      if (!abs) continue
      rememberAllowedPath(abs)
    } catch {
      /* ignore */
    }
  }
}

/** 扫描结果：按源父目录登记类别文件夹到白名单（带缓存，避免每个视频 readdir） */
function rememberClassificationArtifacts(videos: { path: string }[]): void {
  const parentDirs = new Set<string>()
  for (const v of videos) {
    if (!v?.path) continue
    parentDirs.add(exportRootDirFor(v.path))
  }
  beginCategoryScanCache()
  try {
    for (const dir of Array.from(parentDirs)) {
      try {
        for (const catDir of listCategoryDirectories(dir)) {
          rememberAllowedPath(catDir)
        }
      } catch {
        /* ignore */
      }
    }
  } finally {
    endCategoryScanCache()
  }
}

async function rememberClassificationArtifactsAsync(
  videos: { path: string }[]
): Promise<void> {
  try {
    const dirs = await collectCategoryWhitelistPathsAsync(videos, {
      isCancelled: isCancelRequested
    })
    for (const d of dirs) rememberAllowedPath(d)
  } catch {
    /* ignore */
  }
}

async function scanAndRememberAsync(paths: string[]): Promise<VideoItem[]> {
  rememberUserMediaPaths(paths)
  const videos = await scanPathsAsync(paths, {
    fastCompleted: true,
    isCancelled: isCancelRequested,
    onProgress: emitProgress
  })
  // 类别目录白名单异步登记，不堵「正在导入」返回列表
  void rememberClassificationArtifactsAsync(videos)
  return videos
}

function pathResolveSafe(p: string): string {
  return path.resolve(String(p || ''))
}

/** Windows 路径大小写不敏感；白名单比较统一规范化 */
function pathCompareKey(p: string): string {
  const abs = pathResolveSafe(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function isUnderAllowedRoot(abs: string, root: string): boolean {
  const a = pathCompareKey(abs)
  const r = pathCompareKey(root)
  return a === r || a.startsWith(r + path.sep)
}

function isPathAllowed(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const abs = pathResolveSafe(filePath)
  // 缩略图缓存始终可读（含尚未生成的路径前缀判断）
  try {
    const thumbRoot = path.join(app.getPath('userData'), 'thumbnails')
    if (isUnderAllowedRoot(abs, thumbRoot)) return true
  } catch {
    /* ignore */
  }
  // 未导入任何媒体前拒绝任意路径探测，避免空白名单绕过
  if (allowedRoots.size === 0) return false
  // 允许「曾登记但文件已移走/删除」的路径，便于丢弃会话、清理导出
  for (const root of Array.from(allowedRoots)) {
    if (isUnderAllowedRoot(abs, root)) return true
  }
  return false
}

/** 启动时把未完成会话路径纳入白名单，供恢复弹窗使用 */
function seedAllowedRootsFromDisk(): void {
  try {
    for (const s of listPendingSessions()) {
      rememberAllowedPath(s.sourcePath)
      for (const exp of s.exports || []) rememberAllowedPath(exp.path)
    }
  } catch {
    /* ignore */
  }
  // 缩略图缓存目录
  try {
    rememberAllowedPath(path.join(app.getPath('userData'), 'thumbnails'))
  } catch {
    /* ignore */
  }
}

function assertAllowedPath(filePath: string, label = '路径'): void {
  if (!isPathAllowed(filePath)) {
    throw new Error(`${label}不在已打开的媒体范围内`)
  }
}

function emitProgress(message: string): void {
  try {
    mainWindow?.webContents.send('busy-progress', message)
  } catch {
    /* ignore */
  }
}

function enqueueThumbnail(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const run = async (): Promise<void> => {
      while (thumbActive >= THUMB_MAX_CONCURRENT) {
        await new Promise((r) => setTimeout(r, 40))
        if (busy) {
          // 导出中暂停抽帧，避免抢 CPU
          await new Promise((r) => setTimeout(r, 200))
          continue
        }
      }
      thumbActive++
      try {
        const url = await generateThumbnail(filePath)
        resolve(url)
      } catch (err) {
        reject(err)
      } finally {
        thumbActive--
      }
    }
    thumbQueue = thumbQueue.then(run, run)
  })
}

function isDev(): boolean {
  return !app.isPackaged
}

function setBusy(value: boolean): void {
  busy = value
  busySince = value ? Date.now() : 0
  if (value) {
    cancelRequested = false
    setFfmpegCancelChecker(() => cancelRequested)
  } else {
    setFfmpegCancelChecker(null)
  }
  try {
    mainWindow?.webContents.send('busy-changed', value)
  } catch {
    /* window may be gone */
  }
}

function isCancelRequested(): boolean {
  return cancelRequested
}

/** 避免上次异常退出后 busy 一直卡住 */
function assertCanWork(): void {
  if (busy && busySince > 0 && Date.now() - busySince > 180_000) {
    setBusy(false)
  }
  if (busy) throw new Error('正在处理中，请稍候（若长时间卡住请重启应用）')
}

// 必须在 app ready 前注册；用自定义协议播本地媒体，从而可开启 webSecurity
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

function resolveAppIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'icon.png'),
        join(app.getAppPath(), 'build', 'icon.png')
      ]
    : [
        join(app.getAppPath(), 'build', 'icon.png'),
        join(__dirname, '../../build/icon.png'),
        join(__dirname, '../../build/icon.icns')
      ]
  return candidates.find((p) => fs.existsSync(p))
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    // 先显示窗口（背景色），避免等 React/Vite 首屏几秒才出现
    show: true,
    title: 'LabelU Video — 视频剪辑、分类',
    backgroundColor: '#f3eee6',
    autoHideMenuBar: process.platform === 'win32',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('close', (e) => {
    if (allowQuit) return
    if (busy) {
      e.preventDefault()
      dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '正在处理',
        message: '正在导出，请等待完成后再关闭。'
      })
      return
    }
    e.preventDefault()
    // 短时间内再次关窗：渲染进程可能卡住，强制退出
    const now = Date.now()
    if (closeAskAt > 0 && now - closeAskAt < 4000) {
      allowQuit = true
      mainWindow?.destroy()
      return
    }
    closeAskAt = now
    mainWindow?.webContents.send('request-close')
  })

  if (isDev() && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initLogger()
  const startupInfo = applyStartupVersionCheck()
  appendLog(
    'info',
    'app',
    `ready version=${startupInfo.version} upgraded=${startupInfo.upgraded} log=${getExceptionLogPath()}`,
    undefined,
    { force: true }
  )

  // 把启动信息挂到全局，供首屏 IPC 读取（避免重复跑版本逻辑）
  ;(global as unknown as { __labeluStartupInfo?: StartupVersionInfo }).__labeluStartupInfo =
    startupInfo

  const mimeFor = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.mp4' || ext === '.m4v') return 'video/mp4'
    if (ext === '.webm') return 'video/webm'
    if (ext === '.mov') return 'video/quicktime'
    if (ext === '.mkv') return 'video/x-matroska'
    if (ext === '.avi') return 'video/x-msvideo'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    if (ext === '.gif') return 'image/gif'
    if (ext === '.bmp') return 'image/bmp'
    return 'application/octet-stream'
  }

  // 必须支持 Range，否则 video.currentTime 跳转会失败，看起来总像从片头播
  protocol.handle('media', (request) => {
    try {
      const prefix = 'media://abs/'
      if (!request.url.startsWith(prefix)) {
        return new Response('Bad Request', { status: 400 })
      }
      const filePath = decodeURIComponent(request.url.slice(prefix.length))
      if (!isPathAllowed(filePath)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 })
      }

      const stat = fs.statSync(filePath)
      const size = stat.size
      const mime = mimeFor(filePath)
      const range = request.headers.get('Range') || request.headers.get('range')

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          let start = m[1] ? Number.parseInt(m[1], 10) : 0
          let end = m[2] ? Number.parseInt(m[2], 10) : size - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= size) end = size - 1
          if (start > end) {
            return new Response(null, {
              status: 416,
              headers: {
                'Content-Range': `bytes */${size}`,
                'Accept-Ranges': 'bytes'
              }
            })
          }
          const chunk = end - start + 1
          const nodeStream = fs.createReadStream(filePath, { start, end })
          const body = Readable.toWeb(nodeStream) as ReadableStream
          return new Response(body, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(chunk),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache'
            }
          })
        }
      }

      // 无 Range：图片必须整文件返回（img 不会发 Range）；大视频只回头段避免卡死
      const isImage = mime.startsWith('image/')
      const HEAD_CHUNK = 2 * 1024 * 1024
      if (!isImage && size > HEAD_CHUNK) {
        const end = HEAD_CHUNK - 1
        const nodeStream = fs.createReadStream(filePath, { start: 0, end })
        const body = Readable.toWeb(nodeStream) as ReadableStream
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(HEAD_CHUNK),
            'Content-Range': `bytes 0-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
          }
        })
      }

      const nodeStream = fs.createReadStream(filePath)
      const body = Readable.toWeb(nodeStream) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        }
      })
    } catch (err) {
      console.error('[media] handler error', err)
      logError('media-protocol', err)
      return new Response('Not Found', { status: 404 })
    }
  })

  createWindow()
  // 窗口创建后再读撤回缓存 / 自定义标签 / 白名单种子，不挡首屏
  setImmediate(() => {
    initBatchUndoStore()
    loadCustomCategoriesFromDisk()
    seedAllowedRootsFromDisk()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  setupIpc()
  setupUpdater()
})

function customCategoriesStorePath(): string {
  return path.join(app.getPath('userData'), 'custom-category-tags.json')
}

function loadCustomCategoriesFromDisk(): void {
  try {
    const f = customCategoriesStorePath()
    if (!fs.existsSync(f)) return
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<
      Record<ExtensibleGroupId, string[]>
    >
    applyCustomCategoryTags(raw)
  } catch {
    /* ignore */
  }
}

function persistCustomCategoriesToDisk(): void {
  try {
    fs.writeFileSync(
      customCategoriesStorePath(),
      JSON.stringify(getCustomCategoryTags(), null, 2),
      'utf8'
    )
  } catch {
    /* ignore */
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** 后台检查更新时的「正常」失败：首发尚无 Release、网络抖动等，不写异常日志、不弹 toast */
function isBenignUpdaterMiss(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '')
  return /No published versions on GitHub|404|Cannot find .+ in latest|ERR_CONNECTION|ENOTFOUND|ETIMEDOUT|net::ERR_/i.test(
    msg
  )
}

function setupUpdater(): void {
  if (isDev()) return
  try {
    autoUpdater.autoDownload = false
    // 按当前平台只解析/下载对应安装包（win→exe，mac→dmg/zip）
    autoUpdater.on('update-available', (info) => {
      appendLog('info', 'updater', `update-available ${info?.version || ''}`, undefined, {
        force: true
      })
      mainWindow?.webContents.send('update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
      appendLog('info', 'updater', `update-downloaded ${info?.version || ''}`, undefined, {
        force: true
      })
      mainWindow?.webContents.send('update-downloaded')
    })
    autoUpdater.on('error', (err) => {
      if (isBenignUpdaterMiss(err)) {
        appendLog(
          'info',
          'updater',
          `check skipped: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          { force: true }
        )
        return
      }
      logError('updater', err)
      mainWindow?.webContents.send(
        'update-error',
        err instanceof Error ? err.message : String(err)
      )
    })
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        if (isBenignUpdaterMiss(err)) {
          appendLog(
            'info',
            'updater',
            `check skipped: ${err instanceof Error ? err.message : String(err)}`,
            undefined,
            { force: true }
          )
          return
        }
        logError('updater.checkForUpdates', err)
      })
    }, 5000)
  } catch (err) {
    logError('updater.setup', err)
  }
}

function setupIpc(): void {
  /** 仅扫描已在白名单内的路径，不扩权（恢复会话、刷新列表等） */
  ipcMain.handle('scan-paths', async (_e, paths: string[]) => {
    if (!Array.isArray(paths)) throw new Error('路径无效')
    for (const p of paths) assertAllowedPath(p, '路径')
    const videos = await scanPathsAsync(paths, {
      fastCompleted: false,
      isCancelled: isCancelRequested,
      onProgress: emitProgress
    })
    rememberClassificationArtifacts(videos)
    return videos
  })

  /** 拖放导入：异步扫描，避免 Windows 大文件同步 stat 导致窗口未响应 */
  ipcMain.handle('import-user-paths', async (_e, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return []
    assertCanWork()
    setBusy(true)
    emitProgress('正在导入…')
    try {
      clearBatchClassifyUndo()
      return await scanAndRememberAsync(paths)
    } finally {
      setBusy(false)
      emitProgress('')
    }
  })

  /** 解析打开对话框默认路径：文件优先；目录补分隔符（macOS openFile 对纯目录常忽略） */
  function resolveOpenDialogDefaultPath(input?: string): string | undefined {
    if (!input || typeof input !== 'string') return undefined
    const trimmed = input.trim()
    if (!trimmed) return undefined
    try {
      const abs = path.resolve(trimmed)
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs)
        if (st.isFile()) return abs
        if (st.isDirectory()) return abs.endsWith(path.sep) ? abs : abs + path.sep
      }
      // 文件已挪走时，尽量落到仍存在的上级目录
      let cur = abs
      for (let i = 0; i < 8; i++) {
        const parent = path.dirname(cur)
        if (!parent || parent === cur) break
        cur = parent
        if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) {
          return cur.endsWith(path.sep) ? cur : cur + path.sep
        }
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  const MEDIA_DIALOG_FILTERS: Electron.FileFilter[] = [
    {
      name: '媒体',
      extensions: [
        'mp4',
        'avi',
        'mov',
        'mkv',
        'webm',
        'm4v',
        'wmv',
        'flv',
        'jpg',
        'jpeg',
        'png',
        'webp',
        'bmp',
        'gif'
      ]
    },
    {
      name: '视频',
      extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', 'wmv', 'flv']
    },
    {
      name: '图片',
      extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']
    }
  ]

  /**
   * 多选文件或文件夹导入。
   * Windows/Linux 原生对话框无法同时选文件与文件夹（会退化成仅文件夹），
   * 因此先询问模式再打开对应对话框；macOS 可一次兼顾。
   */
  ipcMain.handle(
    'pick-media-files',
    async (_e, opts?: { defaultPath?: string }) => {
      const defaultPath = resolveOpenDialogDefaultPath(opts?.defaultPath)
      let properties: Array<'openFile' | 'openDirectory' | 'multiSelections'>
      let title = '选择文件夹或文件'

      if (process.platform === 'darwin') {
        properties = ['openFile', 'openDirectory', 'multiSelections']
      } else {
        const choice = await dialog.showMessageBox(mainWindow!, {
          type: 'question',
          title: '导入媒体',
          message: '请选择导入方式',
          detail:
            '当前系统无法在同一对话框中同时选择文件与文件夹。可多选；也可直接把文件/文件夹拖进窗口。',
          buttons: ['选择文件夹', '选择文件', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        if (choice.response === 2) return []
        if (choice.response === 0) {
          properties = ['openDirectory', 'multiSelections']
          title = '选择文件夹'
        } else {
          properties = ['openFile', 'multiSelections']
          title = '选择媒体文件'
        }
      }

      const result = await dialog.showOpenDialog(mainWindow!, {
        title,
        ...(defaultPath ? { defaultPath } : {}),
        properties,
        ...(properties.includes('openFile') ? { filters: MEDIA_DIALOG_FILTERS } : {})
      })
      if (result.canceled) return []
      assertCanWork()
      setBusy(true)
      emitProgress('正在导入…')
      try {
        clearBatchClassifyUndo()
        return await scanAndRememberAsync(result.filePaths)
      } finally {
        setBusy(false)
        emitProgress('')
      }
    }
  )

  /** 导入后后台刷新「已完成」标记（不挡界面） */
  ipcMain.handle('refresh-completed-flags', async (_e, videos: VideoItem[]) => {
    if (!Array.isArray(videos) || videos.length === 0) return videos
    return refreshCompletedFlags(videos, { isCancelled: isCancelRequested })
  })

  ipcMain.handle('probe', async (_e, filePath: string) => {
    assertAllowedPath(filePath, '视频')
    return probeVideo(filePath)
  })

  ipcMain.handle('load-session', async (_e, sourcePath: string) => {
    assertAllowedPath(sourcePath, '源视频')
    return loadSession(sourcePath)
  })

  /** 批量查询各源视频剩余可剪秒数（供「只看未完成」列表筛选） */
  ipcMain.handle('batch-remaining-hints', async (_e, paths: string[]) => {
    const result: Record<string, number> = {}
    if (!Array.isArray(paths)) return result
    for (const sourcePath of paths) {
      if (!sourcePath || typeof sourcePath !== 'string') continue
      try {
        assertAllowedPath(sourcePath, '源视频')
        if (isImagePath(sourcePath)) {
          result[sourcePath] = IMAGE_TIMELINE_SECONDS
          continue
        }
        if (isCompleted(sourcePath)) {
          result[sourcePath] = 0
          continue
        }
        const session = await loadSession(sourcePath)
        const probe = await probeVideo(sourcePath)
        const dur =
          (session?.duration && session.duration > 0 ? session.duration : 0) ||
          (probe.duration > 0 ? probe.duration : 0)
        if (!session || !session.exports?.length) {
          result[sourcePath] = dur
          continue
        }
        const rem = computeRemainingFromExports(dur, preciseExports(session.exports))
        result[sourcePath] = totalDuration(rem)
      } catch {
        result[sourcePath] = -1
      }
    }
    return result
  })

  ipcMain.handle('list-pending-sessions', () => listPendingSessions())

  ipcMain.handle('discard-session', (_e, state: SessionState, deleteExports: boolean) => {
    assertAllowedPath(state.sourcePath, '源视频')
    const sourceDir = path.dirname(pathResolveSafe(state.sourcePath))
    const safeExports = (state.exports || []).filter((exp) => {
      const abs = pathResolveSafe(exp.path)
      if (isPathAllowed(abs)) return true
      // 仅允许删除源视频同目录下的导出（含类别子目录），绝不扩白名单
      return isUnderAllowedRoot(abs, sourceDir)
    })
    discardSession({ ...state, exports: safeExports }, deleteExports)
    return true
  })

  ipcMain.handle(
    'set-custom-categories',
    (_e, map: Partial<Record<ExtensibleGroupId, string[]>>) => {
      applyCustomCategoryTags(map)
      persistCustomCategoriesToDisk()
      return true
    }
  )

  ipcMain.handle('get-custom-categories', () => getCustomCategoryTags())

  ipcMain.handle('export-image', async (_e, req: ImageExportRequest) => {
    assertCanWork()
    setBusy(true)
    let outputPath = ''
    try {
      console.log('[labelu] export-image', req.category)
      if (!fs.existsSync(req.sourcePath)) throw new Error('源图片不存在')
      assertAllowedPath(req.sourcePath, '源图片')
      if (!isImagePath(req.sourcePath)) throw new Error('不是图片文件')
      if (!req.category || !String(req.category).trim()) throw new Error('请输入类别')

      const prev = await loadSession(req.sourcePath)
      const duration =
        (prev?.duration && prev.duration > 0 ? prev.duration : 0) || IMAGE_TIMELINE_SECONDS
      const prevPrecise = preciseExports(prev?.exports || [])
      const cropForName =
        req.cropActive && req.crop && isMeaningfulCrop(req.crop) ? req.crop : null
      const ext = preferredImageExportExt(req.sourcePath)
      // 图片用固定虚拟时段写入文件名，便于与视频导出命名一致；剩余区间保持全幅以支持多次裁切
      const range = { start: 0, end: duration }
      outputPath = await nextExportPath(req.sourcePath, req.category, range, cropForName, ext)
      const result = await exportImageCrop({
        sourcePath: req.sourcePath,
        outputPath,
        crop: req.crop,
        cropActive: req.cropActive
      })

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 32) {
        throw new Error('导出失败：输出文件无效')
      }

      const undoEntry: UndoEntry = {
        exportPath: outputPath,
        range,
        category: req.category
      }
      const exports = [
        ...prevPrecise,
        {
          path: outputPath,
          start: range.start,
          end: range.end,
          category: req.category,
          crop: cropForName
        }
      ]
      const undoStack = pushUndo(prev?.undoStack || [], undoEntry, 20)
      const state: SessionState = {
        version: 1,
        sourcePath: req.sourcePath,
        updatedAt: new Date().toISOString(),
        remainingRanges: [{ start: 0, end: duration }],
        duration,
        exports,
        undoStack
      }
      saveSession(state)
      console.log('[labelu] export-image done', outputPath)
      return { ...result, outputPath, session: state }
    } catch (err) {
      console.error('[labelu] export-image failed', err)
      logError('export-image', err, { sourcePath: req.sourcePath, category: req.category })
      if (outputPath) {
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
        } catch {
          /* ignore */
        }
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      setBusy(false)
    }
  })

  ipcMain.handle('export-clip', async (_e, req: ExportRequest) => {
    assertCanWork()
    setBusy(true)
    let outputPath = ''
    try {
      console.log('[labelu] export-clip', req.start, req.end, req.category)
      if (!fs.existsSync(req.sourcePath)) throw new Error('源视频不存在')
      assertAllowedPath(req.sourcePath, '源视频')
      if (!req.category || !String(req.category).trim()) throw new Error('请输入类别')
      if (!(req.end > req.start)) throw new Error('选区无效')

      const probe = await probeVideo(req.sourcePath)
      const prev = await loadSession(req.sourcePath)
      const duration =
        (prev?.duration && prev.duration > 0 ? prev.duration : 0) ||
        (req.duration > 0 ? req.duration : 0) ||
        probe.duration
      if (!(duration > 0)) throw new Error('无法确定视频时长')

      const cutStart = Math.min(req.start, req.end)
      const cutEnd = Math.max(req.start, req.end)
      if (cutEnd - cutStart < 0.05) throw new Error('选区过短')

      // 主进程权威重算剩余区间；忽略 approx 推算段
      const prevPrecise = preciseExports(prev?.exports || [])
      const baseRemaining = computeRemainingFromExports(duration, prevPrecise)
      const check = validateClipSelection(cutStart, cutEnd, baseRemaining, prevPrecise, 25)
      if (!check.ok) {
        throw new Error(check.reason)
      }

      const cropForName =
        req.cropActive && req.crop && isMeaningfulCrop(req.crop) ? req.crop : null
      outputPath = await nextExportPath(
        req.sourcePath,
        req.category,
        { start: cutStart, end: cutEnd },
        cropForName
      )
      const result = await exportClip({
        sourcePath: req.sourcePath,
        start: cutStart,
        end: cutEnd,
        outputPath,
        crop: req.crop,
        cropActive: req.cropActive
      })

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
        throw new Error('导出失败：输出文件无效')
      }

      const undoEntry: UndoEntry = {
        exportPath: outputPath,
        range: { start: cutStart, end: cutEnd },
        category: req.category
      }
      const exports = [
        ...prevPrecise,
        {
          path: outputPath,
          start: cutStart,
          end: cutEnd,
          category: req.category,
          crop: cropForName
        }
      ]
      const remaining = computeRemainingFromExports(duration, exports)
      const undoStack = pushUndo(prev?.undoStack || [], undoEntry, 20)
      const state: SessionState = {
        version: 1,
        sourcePath: req.sourcePath,
        updatedAt: new Date().toISOString(),
        remainingRanges: remaining,
        duration,
        exports,
        undoStack
      }
      saveSession(state)
      console.log('[labelu] export-clip done', outputPath)
      return { ...result, outputPath, session: state }
    } catch (err) {
      console.error('[labelu] export-clip failed', err)
      logError('export-clip', err, {
        sourcePath: req.sourcePath,
        start: req.start,
        end: req.end,
        category: req.category
      })
      if (outputPath) {
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
        } catch {
          /* ignore partial cleanup */
        }
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      setBusy(false)
    }
  })

  ipcMain.handle('undo-export', async (_e, sourcePath: string) => {
    assertCanWork()
    assertAllowedPath(sourcePath, '源视频')
    setBusy(true)
    try {
      const state = await loadSession(sourcePath)
      if (!state || state.undoStack.length === 0) {
        throw new Error('没有可撤销的操作')
      }
      const entry = state.undoStack[state.undoStack.length - 1]
      assertAllowedPath(entry.exportPath, '导出片段')
      if (fs.existsSync(entry.exportPath)) {
        fs.unlinkSync(entry.exportPath)
      }
      try {
        const meta = clipSidecarPath(entry.exportPath)
        if (fs.existsSync(meta)) fs.unlinkSync(meta)
      } catch {
        /* ignore */
      }
      const exports = preciseExports(
        state.exports.filter((x) => x.path !== entry.exportPath)
      )
      const undoStack = state.undoStack.slice(0, -1)
      const remaining = computeRemainingFromExports(state.duration, exports)
      const next: SessionState = {
        ...state,
        remainingRanges: remaining,
        exports,
        undoStack,
        updatedAt: new Date().toISOString()
      }
      if (exports.length === 0) {
        clearSession(sourcePath)
        clearSidecar(sourcePath)
      } else {
        saveSession(next)
      }
      return next
    } finally {
      setBusy(false)
    }
  })

  ipcMain.handle('delete-export', async (_e, sourcePath: string, exportPath: string) => {
    assertCanWork()
    assertAllowedPath(sourcePath, '源视频')
    assertAllowedPath(exportPath, '导出片段')
    setBusy(true)
    try {
      const state = await loadSession(sourcePath)
      if (!state) throw new Error('没有会话记录')
      const exp = state.exports.find((x) => x.path === exportPath)
      if (!exp) throw new Error('找不到该分类片段')
      if (fs.existsSync(exportPath)) {
        fs.unlinkSync(exportPath)
      }
      try {
        const meta = clipSidecarPath(exportPath)
        if (fs.existsSync(meta)) fs.unlinkSync(meta)
      } catch {
        /* ignore */
      }
      const exports = preciseExports(state.exports.filter((x) => x.path !== exportPath))
      const undoStack = state.undoStack.filter((u) => u.exportPath !== exportPath)
      const remaining = computeRemainingFromExports(state.duration, exports)
      const next: SessionState = {
        ...state,
        remainingRanges: remaining,
        exports,
        undoStack,
        updatedAt: new Date().toISOString()
      }
      if (exports.length === 0) {
        clearSession(sourcePath)
        clearSidecar(sourcePath)
        return {
          ...next,
          exports: [],
          undoStack: [],
          remainingRanges: remaining
        }
      }
      saveSession(next)
      return next
    } finally {
      setBusy(false)
    }
  })

  ipcMain.handle(
    'finish-video',
    async (
      _e,
      payload: {
        sourcePath: string
        hasExported: boolean
        /** 批量「回家」扫列表：无会话时静默跳过，勿抛错刷日志 */
        soft?: boolean
        /** 无导出记录时也写入已完成标记（源文件名加 `_done`） */
        markDone?: boolean
      }
    ) => {
      assertCanWork()
      const { sourcePath, hasExported, soft, markDone } = payload
      assertAllowedPath(sourcePath, '源视频')
      setBusy(true)
      emitProgress('正在完成…')
      try {
        // 完成必须以工作区会话为准；旁路只用于回看
        const session =
          loadWorkspaceSession(sourcePath) || (await loadSession(sourcePath))
        const precise = preciseExports(session?.exports || [])
        const exportCount = precise.length
        if (exportCount === 0 || !session) {
          if (markDone) {
            emitProgress('标记完成…')
            clearSidecar(sourcePath)
            const donePath = await markCompleted(sourcePath)
            rememberAllowedPath(donePath)
            clearSession(sourcePath)
            return { action: 'kept' as const, path: donePath }
          }
          if (!hasExported) {
            clearSession(sourcePath)
            return { action: 'none' as const, path: sourcePath }
          }
          if (soft) {
            return { action: 'none' as const, path: sourcePath }
          }
          throw new Error('找不到剪辑会话记录，请重新打开该视频后再完成')
        }

        // 分类信息已写在导出文件名中；清掉旧旁路 JSON；完成态写在源文件名 `_done` 上
        emitProgress('标记完成…')
        clearSidecar(sourcePath)
        const donePath = await markCompleted(sourcePath)
        rememberAllowedPath(donePath)
        clearSession(sourcePath)
        return { action: 'kept' as const, path: donePath }
      } finally {
        setBusy(false)
        emitProgress('')
      }
    }
  )

  ipcMain.handle('cancel-busy-work', () => {
    if (!busy) return { ok: false, message: '当前没有进行中的任务' }
    cancelRequested = true
    killActiveFfmpeg()
    emitProgress('正在取消…')
    return { ok: true }
  })

  ipcMain.handle('clear-completed', async (_e, sourcePath: string) => {
    assertAllowedPath(sourcePath, '源视频')
    const nextPath = await clearCompletedFlag(sourcePath)
    rememberAllowedPath(nextPath)
    return { path: nextPath }
  })

  ipcMain.handle(
    'remove-from-workspace',
    async (_e, sourcePath: string, deleteSourceFile: boolean) => {
      assertAllowedPath(sourcePath, '源文件')
      await removeFromWorkspace(sourcePath, Boolean(deleteSourceFile))
      return true
    }
  )

  ipcMain.handle(
    'log-client-error',
    (
      _e,
      payload: {
        tag?: string
        message?: string
        stack?: string
        extra?: unknown
      }
    ) => {
      const tag = String(payload?.tag || 'renderer')
      const message = String(payload?.message || 'unknown')
      const stack = payload?.stack ? String(payload.stack) : ''
      appendLog('error', tag, stack ? `${message}\n${stack}` : message, payload?.extra)
      return {
        ok: true,
        logDir: getLogDir(),
        logPath: getExceptionLogPath()
      }
    }
  )

  ipcMain.handle('get-startup-info', () => {
    const cached = (global as unknown as { __labeluStartupInfo?: StartupVersionInfo })
      .__labeluStartupInfo
    if (cached) return cached
    return applyStartupVersionCheck()
  })

  ipcMain.handle('mark-whats-new-seen', (_e, version?: string) => {
    markWhatsNewSeen(typeof version === 'string' ? version : undefined)
    return true
  })

  ipcMain.handle('open-exception-log', async () => {
    const file = getExceptionLogPath()
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '', 'utf8')
      }
      const err = await shell.openPath(file)
      if (err) {
        // 个别环境无法直接打开文件时，退化为打开所在目录
        await shell.openPath(path.dirname(file))
        return { ok: false, path: file, error: err }
      }
      return { ok: true, path: file }
    } catch (e) {
      logError('open-exception-log', e)
      return {
        ok: false,
        path: file,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle(
    'batch-classify',
    async (_e, paths: string[], category: string, opts?: ClassifyDestOptions) => {
      assertCanWork()
      const cat = String(category || '').trim()
      if (!cat) throw new Error('请输入类别')
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('未选择视频')
      for (const p of paths) assertAllowedPath(p, '视频')
      const classifyOpts: ClassifyDestOptions | undefined = opts
        ? {
            reclassifyMode: opts.reclassifyMode,
            customDestDir: opts.customDestDir ? String(opts.customDestDir) : undefined
          }
        : undefined
      if (classifyOpts?.customDestDir) {
        rememberAllowedPath(classifyOpts.customDestDir)
      }

      setBusy(true)
      try {
        const results: {
          path: string
          ok: boolean
          exportPath?: string
          error?: string
        }[] = []
        const moves: BatchClassifyMove[] = []
        let cancelled = false
        for (let i = 0; i < paths.length; i++) {
          if (isCancelRequested()) {
            cancelled = true
            emitProgress(
              `已取消：已移动 ${moves.length} 个，可用撤回移回原目录；未处理的不会改动`
            )
            break
          }
          const p = paths[i]
          emitProgress(`批量分类 ${i + 1}/${paths.length}`)
          const session = loadWorkspaceSession(p)
          if (session?.exports?.length) {
            results.push({
              path: p,
              ok: false,
              error: '该视频还有未完成的剪辑会话，请先在右侧点「完成」'
            })
            continue
          }
          try {
            const { sourcePath, exportPath } = await classifyWholeFileAsync(p, cat, classifyOpts)
            rememberAllowedPath(exportPath)
            rememberAllowedPath(sourcePath)
            // path 固定回传请求路径，便于渲染进程匹配列表项（即使中途去掉了 _done）
            results.push({
              path: p,
              ok: true,
              exportPath
            })
            const samePath =
              process.platform === 'win32'
                ? path.resolve(sourcePath).toLowerCase() === path.resolve(exportPath).toLowerCase()
                : path.resolve(sourcePath) === path.resolve(exportPath)
            if (!samePath) {
              moves.push({ originalPath: sourcePath, newPath: exportPath })
            }
          } catch (err) {
            results.push({
              path: p,
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
        if (moves.length > 0) {
          appendBatchClassifyUndo(moves)
        }
        const canUndo = Boolean(peekBatchClassifyUndo()?.length)
        return { results, canUndo, cancelled }
      } finally {
        setBusy(false)
        emitProgress('')
      }
    }
  )

  ipcMain.handle(
    'pick-directory',
    async (_e, opts?: { defaultPath?: string; title?: string }) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: opts?.title || '选择目标文件夹',
        properties: ['openDirectory', 'createDirectory'],
        ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {})
      })
      if (result.canceled || !result.filePaths[0]) return null
      rememberAllowedPath(result.filePaths[0])
      return result.filePaths[0]
    }
  )

  ipcMain.handle('undo-batch-classify', async () => {
    assertCanWork()
    const moves = takeBatchClassifyUndo()
    if (!moves?.length) throw new Error('没有可撤回的批量分类')
    setBusy(true)
    try {
      emitProgress('正在撤回批量分类…')
      for (const m of moves) {
        assertAllowedPath(m.newPath, '视频')
        rememberAllowedPath(m.originalPath)
      }
      const result = await undoBatchClassifyMoves(moves)
      if (result.errors.length && result.restored < moves.length) {
        const failed = moves.filter(
          (m) => fs.existsSync(m.newPath) && !fs.existsSync(m.originalPath)
        )
        restoreBatchClassifyUndo(failed)
      }
      return result
    } finally {
      setBusy(false)
      emitProgress('')
    }
  })

  ipcMain.handle('download-update', async () => {
    await autoUpdater.downloadUpdate()
    return true
  })

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('get-media-url', (_e, filePath: string) => {
    assertAllowedPath(filePath, '视频')
    return toMediaUrl(filePath)
  })

  ipcMain.handle('get-thumbnail', async (_e, filePath: string) => {
    assertAllowedPath(filePath, '视频')
    return enqueueThumbnail(filePath)
  })

  ipcMain.handle('confirm-quit', (_e, shouldQuit: boolean) => {
    if (shouldQuit) {
      allowQuit = true
      closeAskAt = 0
      app.quit()
    } else {
      closeAskAt = 0
    }
  })
}
