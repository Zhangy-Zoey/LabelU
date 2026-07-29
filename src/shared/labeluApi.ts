import type {
  ExportRequest,
  ImageExportRequest,
  SessionState,
  VideoItem
} from './types'

/** 渲染进程 `window.api` 与 preload 共用的类型（勿从 preload 反引，web tsconfig 不包含 electron） */
export type CustomCategoryMap = {
  normal: string[]
  abnormal: string[]
  danger: string[]
  other: string[]
  /** 用户删除的内置标签（仅隐藏列表） */
  removedBuiltins?: string[]
}

/** 二次分类落点；与 main/exportPaths.ReclassifyDestMode 一致 */
export type ReclassifyDestMode = 'originalRoot' | 'underCurrent' | 'custom' | 'customRoot'

export type ClassifyDestApiOpts = {
  reclassifyMode?: ReclassifyDestMode
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
  moves?: { originalPath: string; newPath: string }[]
}

export type StartupInfo = {
  version: string
  previousVersion: string | null
  upgraded: boolean
  showWhatsNew: boolean
  whatsNewTitle: string
  whatsNewLines: string[]
}

/** 一键更新前工作区快照（main/workspaceResume 与渲染进程共用） */
export type WorkspaceResumeSnapshot = {
  version: 1
  reason: 'post-update'
  savedAt: string
  paths: string[]
  currentPath?: string | null
  onlyIncomplete?: boolean
  mediaKindFilter?: 'all' | 'video' | 'image'
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
    /** 强制发信并附整份 exceptions.log（崩溃 / 保存失败等） */
    forceMail?: boolean
  }) => Promise<{ ok: boolean; logDir: string; logPath: string }>
  getStartupInfo: () => Promise<StartupInfo>
  markWhatsNewSeen: (version?: string) => Promise<boolean>
  openOperationsLog: () => Promise<{ ok: boolean; path: string; error?: string }>
  opHistoryState: () => Promise<import('./opTypes').HistoryStateSnapshot>
  opHistoryPush: (payload: {
    kind: import('./opTypes').OpKind
    label: string
    undo: unknown
    redo: unknown
    detail?: unknown
  }) => Promise<{
    entry: import('./opTypes').OpHistoryEntry
    state: import('./opTypes').HistoryStateSnapshot
  }>
  opHistoryLog: (payload: { kind: string; label: string; detail?: unknown }) => Promise<boolean>
  opHistoryUndo: () => Promise<{
    entry: import('./opTypes').OpHistoryEntry | null
    state: import('./opTypes').HistoryStateSnapshot
  }>
  opHistoryRedo: () => Promise<{
    entry: import('./opTypes').OpHistoryEntry | null
    state: import('./opTypes').HistoryStateSnapshot
  }>
  /** 撤销/复原执行失败时把条目推回对应栈 */
  opHistoryRestoreUndo: (
    entry: import('./opTypes').OpHistoryEntry
  ) => Promise<import('./opTypes').HistoryStateSnapshot>
  opHistoryRestoreRedo: (
    entry: import('./opTypes').OpHistoryEntry
  ) => Promise<import('./opTypes').HistoryStateSnapshot>
  opHistoryPatch: (payload: {
    id: string
    undo?: unknown
    redo?: unknown
  }) => Promise<{ ok: boolean; state: import('./opTypes').HistoryStateSnapshot }>
  /** 从历史栈移除指定条目（不执行 undo 载荷；用于已直接撤回的批量） */
  opHistoryRemove: (id: string) => Promise<{ ok: boolean; state: import('./opTypes').HistoryStateSnapshot }>
  undoBatchClassifyMoves: (
    moves: { originalPath: string; newPath: string }[]
  ) => Promise<{ restored: number; errors: string[] }>
  redoBatchClassifyMoves: (
    moves: { originalPath: string; newPath: string }[]
  ) => Promise<{ restored: number; errors: string[] }>
  batchClassify: (
    paths: string[],
    category: string,
    opts?: ClassifyDestApiOpts
  ) => Promise<BatchClassifyResult>
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
  /** 一键更新前保存工作区；重启后 consume 恢复 */
  saveWorkspaceResume: (snapshot: WorkspaceResumeSnapshot) => Promise<{ ok: boolean }>
  consumeWorkspaceResume: () => Promise<WorkspaceResumeSnapshot | null>
  openAbout: (opts?: { autoUpdate?: boolean }) => Promise<boolean>
  getMediaUrl: (filePath: string) => Promise<string>
  /** HEVC 等：优先硬解；无 force 时复用已有代理缓存，播失败可 force */
  ensurePreviewProxy: (
    filePath: string,
    force?: boolean,
    quiet?: boolean
  ) => Promise<{ path: string; url: string; proxied: boolean }>
  getThumbnail: (filePath: string) => Promise<{ url: string; width: number; height: number }>
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
  onAppUndo: (cb: () => void) => () => void
  onAppRedo: (cb: () => void) => () => void
}
