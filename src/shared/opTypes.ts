import type { CropRect, TimeRange } from './types'
import type { ClassifyDestApiOpts } from './labeluApi'

/** 操作日志 / 统一历史共用类型（可序列化落盘） */
export type OpKind =
  | 'export'
  | 'batchClassify'
  | 'uiSelection'
  | 'uiMarkers'
  | 'uiCrop'
  | 'uiSelectMedia'
  | 'deleteExport'
  | 'finishVideo'

export type OpUiTimelineState = {
  sourcePath: string
  selStart: number
  selEnd: number
  fineTuneWhich: 'in' | 'out' | null
  markers: { id: string; time: number }[]
  crop: CropRect
  cropActive: boolean
  selectedIds: string[]
  secondaryIds: string[]
}

export type OpExportPayload = {
  mediaKind: 'video' | 'image'
  sourcePath: string
  exportPath: string
  category: string
  range: TimeRange
  crop: CropRect | null
  cropActive: boolean
  duration: number
  dest?: ClassifyDestApiOpts
  remainingBefore: TimeRange[]
  remainingAfter: TimeRange[]
}

export type OpBatchClassifyPayload = {
  category: string
  dest?: ClassifyDestApiOpts
  moves: { originalPath: string; newPath: string }[]
  /** 批量前列表中的路径，便于复原后刷新 */
  requestPaths: string[]
}

export type OpDeleteExportPayload = {
  sourcePath: string
  exportPath: string
  record: {
    path: string
    start: number
    end: number
    category: string
    crop?: CropRect | null
  }
  remainingBefore: TimeRange[]
  remainingAfter: TimeRange[]
}

export type OpHistoryEntry = {
  id: string
  at: string
  kind: OpKind
  label: string
  /** 撤销时恢复到此状态 / 执行的逆操作数据 */
  undo: unknown
  /** 复原时再次应用的数据 */
  redo: unknown
}

export type OpLogEntry = {
  id: string
  at: string
  kind: OpKind | string
  label: string
  /** 完整业务 + UI 快照，供按日志复现 */
  detail: unknown
}

export type HistoryStateSnapshot = {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undoCount: number
  redoCount: number
}

export const OP_HISTORY_MAX = 80
