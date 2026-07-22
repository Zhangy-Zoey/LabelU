export const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.wmv', '.flv']

/** 可导入的图片（批量分类 / 裁切保存） */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']

export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] as const

export const MIN_SELECTION_SECONDS = 0.5

/** 图片在时间轴上的虚拟时长（满足最小选区，便于复用裁切保存流程） */
export const IMAGE_TIMELINE_SECONDS = 2

export type MediaKind = 'video' | 'image'

export function mediaKindFromPath(filePath: string): MediaKind | null {
  // 只用最后一段文件名取扩展名，避免 Windows 路径中目录名含 '.' 时误解析
  // （如 D:\work\release.v2\clip.mp4）
  const base = filePath.replace(/\\/g, '/').split('/').pop() || filePath
  const idx = base.lastIndexOf('.')
  const ext = idx >= 0 ? base.slice(idx).toLowerCase() : ''
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video'
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image'
  return null
}

export function isImagePath(filePath: string): boolean {
  return mediaKindFromPath(filePath) === 'image'
}

export interface TimeRange {
  start: number
  end: number
}

export interface CropRect {
  /** Normalized 0–1 relative to video display */
  x: number
  y: number
  width: number
  height: number
}

export interface VideoItem {
  id: string
  path: string
  name: string
  parentDirName: string
  dirPath: string
  completed: boolean
  /** 位于类别子目录（批量归类后的位置） */
  isCategoryCopy?: boolean
  mediaKind?: MediaKind
}

export interface ExportRecord {
  path: string
  start: number
  end: number
  category: string
  crop?: CropRect | null
  /** 由磁盘历史片段推算的时段，仅用于回看展示 */
  approx?: boolean
}

export interface SessionState {
  version: 1
  sourcePath: string
  updatedAt: string
  remainingRanges: TimeRange[]
  exports: ExportRecord[]
  undoStack: UndoEntry[]
  duration: number
}

export interface UndoEntry {
  exportPath: string
  range: TimeRange
  category: string
}

export interface ExportRequest {
  sourcePath: string
  start: number
  end: number
  category: string
  crop: CropRect | null
  /** true if user has modified crop from full frame */
  cropActive: boolean
  duration: number
}

/** 图片裁切保存请求 */
export interface ImageExportRequest {
  sourcePath: string
  category: string
  crop: CropRect | null
  cropActive: boolean
}
