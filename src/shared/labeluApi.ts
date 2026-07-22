import type {
  ExportRequest,
  ImageExportRequest,
  SessionState,
  VideoItem
} from './types'

/** 渲染进程 `window.api` 与 preload 共用的类型（勿从 preload 反引，web tsconfig 不包含 electron） */
export type CustomCategoryMap = Record<
  'normal' | 'abnormal' | 'danger' | 'other',
  string[]
>

export type ClassifyDestApiOpts = {
  reclassifyMode?: 'originalRoot' | 'underCurrent' | 'custom' | 'customRoot'
  customDestDir?: string
}

export type BatchClassifyResult = {
  results: {
    path: string
    ok: boolean
    exportPath?: string
    error?: string
  }[]
  canUndo: boolean
  cancelled?: boolean
}

export type StartupInfo = {
  version: string
  previousVersion: string | null
  upgraded: boolean
  showWhatsNew: boolean
  whatsNewTitle: string
  whatsNewLines: string[]
}

export type LabeluApi = {
  scanPaths: (paths: string[]) => Promise<VideoItem[]>
  importUserPaths: (paths: string[]) => Promise<VideoItem[]>
  pickMediaFiles: (opts?: { defaultPath?: string }) => Promise<VideoItem[]>
  probe: (filePath: string) => Promise<{
    duration: number
    width: number
    height: number
    hasAudio: boolean
    isVfr: boolean
    rotation: number
    fps: number
    videoCodec: string
    needsPreviewProxy: boolean
  }>
  loadSession: (sourcePath: string) => Promise<SessionState | null>
  batchRemainingHints: (paths: string[]) => Promise<Record<string, number>>
  listPendingSessions: () => Promise<SessionState[]>
  discardSession: (state: SessionState, deleteExports: boolean) => Promise<boolean>
  setCustomCategories: (map: Partial<CustomCategoryMap>) => Promise<boolean>
  getCustomCategories: () => Promise<CustomCategoryMap>
  exportClip: (req: ExportRequest) => Promise<{
    usedReencode?: boolean
    message?: string
    outputPath: string
    session: SessionState
  }>
  exportImage: (req: ImageExportRequest) => Promise<{
    message?: string
    outputPath: string
    session: SessionState
  }>
  undoExport: (sourcePath: string) => Promise<SessionState>
  deleteExport: (sourcePath: string, exportPath: string) => Promise<SessionState>
  finishVideo: (payload: {
    sourcePath: string
    hasExported: boolean
    soft?: boolean
    markDone?: boolean
  }) => Promise<{ action: 'kept' | 'none'; path: string }>
  onBusyProgress: (cb: (message: string) => void) => () => void
  clearCompleted: (sourcePath: string) => Promise<{ path: string }>
  removeFromWorkspace: (sourcePath: string, deleteSourceFile: boolean) => Promise<boolean>
  logClientError: (payload: {
    tag?: string
    message?: string
    stack?: string
    extra?: unknown
  }) => Promise<{ ok: boolean; logDir: string; logPath: string }>
  getStartupInfo: () => Promise<StartupInfo>
  markWhatsNewSeen: (version?: string) => Promise<boolean>
  openExceptionLog: () => Promise<{ ok: boolean; path: string; error?: string }>
  batchClassify: (
    paths: string[],
    category: string,
    opts?: ClassifyDestApiOpts
  ) => Promise<BatchClassifyResult>
  undoBatchClassify: () => Promise<{ restored: number; errors: string[] }>
  pickDirectory: (opts?: { defaultPath?: string; title?: string }) => Promise<string | null>
  cancelBusyWork: () => Promise<{ ok: boolean; message?: string }>
  downloadUpdate: () => Promise<unknown>
  installUpdate: () => Promise<unknown>
  checkForUpdates: () => Promise<{
    ok: boolean
    updateAvailable: boolean
    version: string
    reason?: string
  }>
  openAbout: (opts?: { autoUpdate?: boolean }) => Promise<boolean>
  getMediaUrl: (filePath: string) => Promise<string>
  /** HEVC 等编码在 Windows 上转 H.264 预览代理；可播则返回原路径 */
  ensurePreviewProxy: (
    filePath: string,
    force?: boolean,
    quiet?: boolean
  ) => Promise<{ path: string; url: string; proxied: boolean }>
  getThumbnail: (filePath: string) => Promise<string>
  confirmQuit: (shouldQuit: boolean) => Promise<unknown>
  getPathForFile: (file: File) => string
  refreshCompletedFlags: (videos: VideoItem[]) => Promise<VideoItem[]>
  onBusyChanged: (cb: (busy: boolean) => void) => () => void
  onRequestClose: (cb: () => void) => () => void
  onUpdateAvailable: (cb: (info: unknown) => void) => () => void
  onUpdateDownloaded: (cb: () => void) => () => void
  onUpdateError: (cb: (message: string) => void) => () => void
  onUpdateDownloadProgress: (cb: (percent: number) => void) => () => void
  /** 菜单「检查更新」：关于窗已打开时再次触发自动检查/下载 */
  onAboutAutoUpdate: (cb: () => void) => () => void
}
