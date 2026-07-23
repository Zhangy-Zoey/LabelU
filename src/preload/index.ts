import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ExportRequest, ImageExportRequest, SessionState, VideoItem } from '../shared/types'
import type { LabeluApi } from '../shared/labeluApi'

const api: LabeluApi = {
  /** 仅扫描已允许路径（不扩白名单） */
  scanPaths: (paths) => ipcRenderer.invoke('scan-paths', paths),
  /** 拖放导入：扩白名单并扫描 */
  importUserPaths: (paths) => ipcRenderer.invoke('import-user-paths', paths),
  pickMediaFiles: (opts) => ipcRenderer.invoke('pick-media-files', opts ?? {}),
  probe: (filePath) => ipcRenderer.invoke('probe', filePath),
  loadSession: (sourcePath) => ipcRenderer.invoke('load-session', sourcePath),
  batchRemainingHints: (paths) => ipcRenderer.invoke('batch-remaining-hints', paths),
  listPendingSessions: () => ipcRenderer.invoke('list-pending-sessions'),
  discardSession: (state, deleteExports) =>
    ipcRenderer.invoke('discard-session', state, deleteExports),
  setCustomCategories: (map) => ipcRenderer.invoke('set-custom-categories', map),
  getCustomCategories: () => ipcRenderer.invoke('get-custom-categories'),
  exportClip: (req: ExportRequest) => ipcRenderer.invoke('export-clip', req),
  exportImage: (req: ImageExportRequest) => ipcRenderer.invoke('export-image', req),
  undoExport: (sourcePath) => ipcRenderer.invoke('undo-export', sourcePath),
  deleteExport: (sourcePath, exportPath) =>
    ipcRenderer.invoke('delete-export', sourcePath, exportPath),
  finishVideo: (payload) => ipcRenderer.invoke('finish-video', payload),
  onBusyProgress: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, msg: string): void => cb(msg || '')
    ipcRenderer.on('busy-progress', listener)
    return () => ipcRenderer.removeListener('busy-progress', listener)
  },
  clearCompleted: (sourcePath) => ipcRenderer.invoke('clear-completed', sourcePath),
  removeFromWorkspace: (sourcePath, deleteSourceFile) =>
    ipcRenderer.invoke('remove-from-workspace', sourcePath, deleteSourceFile),
  logClientError: (payload) => ipcRenderer.invoke('log-client-error', payload),
  getStartupInfo: () => ipcRenderer.invoke('get-startup-info'),
  markWhatsNewSeen: (version) => ipcRenderer.invoke('mark-whats-new-seen', version),
  openExceptionLog: () => ipcRenderer.invoke('open-exception-log'),
  batchClassify: (paths, category, opts) =>
    ipcRenderer.invoke('batch-classify', paths, category, opts),
  undoBatchClassify: () => ipcRenderer.invoke('undo-batch-classify'),
  pickDirectory: (opts) => ipcRenderer.invoke('pick-directory', opts ?? {}),
  cancelBusyWork: () => ipcRenderer.invoke('cancel-busy-work'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  saveWorkspaceResume: (snapshot) => ipcRenderer.invoke('save-workspace-resume', snapshot),
  consumeWorkspaceResume: () => ipcRenderer.invoke('consume-workspace-resume'),
  openAbout: (opts) => ipcRenderer.invoke('open-about', opts ?? {}),
  getMediaUrl: (filePath) => ipcRenderer.invoke('get-media-url', filePath),
  ensurePreviewProxy: (filePath, force, quiet) =>
    ipcRenderer.invoke('ensure-preview-proxy', filePath, Boolean(force), Boolean(quiet)),
  getThumbnail: (filePath) => ipcRenderer.invoke('get-thumbnail', filePath),
  confirmQuit: (shouldQuit) => ipcRenderer.invoke('confirm-quit', shouldQuit),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  refreshCompletedFlags: (videos: VideoItem[]) =>
    ipcRenderer.invoke('refresh-completed-flags', videos),
  onBusyChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, v: boolean): void => cb(v)
    ipcRenderer.on('busy-changed', listener)
    return () => ipcRenderer.removeListener('busy-changed', listener)
  },
  onRequestClose: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('request-close', listener)
    return () => ipcRenderer.removeListener('request-close', listener)
  },
  onUpdateAvailable: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, info: unknown): void => cb(info)
    ipcRenderer.on('update-available', listener)
    return () => ipcRenderer.removeListener('update-available', listener)
  },
  onUpdateDownloaded: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('update-downloaded', listener)
    return () => ipcRenderer.removeListener('update-downloaded', listener)
  },
  onUpdateError: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, message: string): void =>
      cb(String(message || ''))
    ipcRenderer.on('update-error', listener)
    return () => ipcRenderer.removeListener('update-error', listener)
  },
  onUpdateDownloadProgress: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, percent: number): void =>
      cb(Number(percent) || 0)
    ipcRenderer.on('update-download-progress', listener)
    return () => ipcRenderer.removeListener('update-download-progress', listener)
  },
  onAboutAutoUpdate: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('about-auto-update', listener)
    return () => ipcRenderer.removeListener('about-auto-update', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
