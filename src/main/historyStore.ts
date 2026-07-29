import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import {
  OP_HISTORY_MAX,
  type HistoryStateSnapshot,
  type OpHistoryEntry,
  type OpKind,
  type OpLogEntry
} from '../shared/opTypes'
import { appendOperation } from './opLog'

type StoreFile = {
  version: 1
  undo: OpHistoryEntry[]
  redo: OpHistoryEntry[]
}

let undoStack: OpHistoryEntry[] = []
let redoStack: OpHistoryEntry[] = []

function storePath(): string {
  return path.join(app.getPath('userData'), 'op-history.json')
}

function persist(): void {
  try {
    const data: StoreFile = { version: 1, undo: undoStack, redo: redoStack }
    fs.writeFileSync(storePath(), JSON.stringify(data), 'utf8')
  } catch {
    /* ignore */
  }
}

export function initHistoryStore(): void {
  undoStack = []
  redoStack = []
  try {
    const f = storePath()
    if (!fs.existsSync(f)) return
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as StoreFile
    if (raw?.version === 1 && Array.isArray(raw.undo) && Array.isArray(raw.redo)) {
      undoStack = raw.undo.slice(-OP_HISTORY_MAX)
      redoStack = raw.redo.slice(-OP_HISTORY_MAX)
    }
  } catch {
    undoStack = []
    redoStack = []
  }
}

export function historySnapshot(): HistoryStateSnapshot {
  const u = undoStack[undoStack.length - 1]
  const r = redoStack[redoStack.length - 1]
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: u?.label ?? null,
    redoLabel: r?.label ?? null,
    undoCount: undoStack.length,
    redoCount: redoStack.length
  }
}

export function historyPush(input: {
  kind: OpKind
  label: string
  undo: unknown
  redo: unknown
  detail?: unknown
}): OpHistoryEntry {
  const entry: OpHistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: input.kind,
    label: input.label,
    undo: input.undo,
    redo: input.redo
  }
  undoStack = [...undoStack, entry].slice(-OP_HISTORY_MAX)
  redoStack = []
  persist()

  const log: OpLogEntry = {
    id: entry.id,
    at: entry.at,
    kind: entry.kind,
    label: entry.label,
    detail: input.detail ?? { undo: input.undo, redo: input.redo }
  }
  appendOperation(log)
  return entry
}

/** 仅记日志、不进入撤销栈（例如导航类） */
export function historyLogOnly(input: {
  kind: string
  label: string
  detail?: unknown
}): void {
  appendOperation({
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: input.kind,
    label: input.label,
    detail: input.detail ?? null
  })
}

export function historyPopUndo(): OpHistoryEntry | null {
  if (undoStack.length === 0) return null
  const entry = undoStack[undoStack.length - 1]
  undoStack = undoStack.slice(0, -1)
  redoStack = [...redoStack, entry].slice(-OP_HISTORY_MAX)
  persist()
  appendOperation({
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: 'undo',
    label: `撤销：${entry.label}`,
    detail: { targetId: entry.id, kind: entry.kind }
  })
  return entry
}

/** 撤销执行失败时：把条目从 redo 顶挪回 undo，避免栈与状态脱节 */
export function historyRestoreFailedUndo(entry: OpHistoryEntry): void {
  if (redoStack.length > 0 && redoStack[redoStack.length - 1].id === entry.id) {
    redoStack = redoStack.slice(0, -1)
  } else {
    redoStack = redoStack.filter((e) => e.id !== entry.id)
  }
  if (!undoStack.some((e) => e.id === entry.id)) {
    undoStack = [...undoStack, entry].slice(-OP_HISTORY_MAX)
  }
  persist()
}

export function historyPopRedo(): OpHistoryEntry | null {
  if (redoStack.length === 0) return null
  const entry = redoStack[redoStack.length - 1]
  redoStack = redoStack.slice(0, -1)
  undoStack = [...undoStack, entry].slice(-OP_HISTORY_MAX)
  persist()
  appendOperation({
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: 'redo',
    label: `复原：${entry.label}`,
    detail: { targetId: entry.id, kind: entry.kind }
  })
  return entry
}

/** 复原执行失败时：把条目从 undo 顶挪回 redo */
export function historyRestoreFailedRedo(entry: OpHistoryEntry): void {
  if (undoStack.length > 0 && undoStack[undoStack.length - 1].id === entry.id) {
    undoStack = undoStack.slice(0, -1)
  } else {
    undoStack = undoStack.filter((e) => e.id !== entry.id)
  }
  if (!redoStack.some((e) => e.id === entry.id)) {
    redoStack = [...redoStack, entry].slice(-OP_HISTORY_MAX)
  }
  persist()
}

/** 就地修补某条历史的 undo/redo 载荷（用于删除导出撤销后回写新 exportPath） */
export function historyPatchEntry(
  id: string,
  patch: { undo?: unknown; redo?: unknown }
): boolean {
  const key = String(id || '')
  if (!key) return false
  let found = false
  const apply = (list: OpHistoryEntry[]): OpHistoryEntry[] =>
    list.map((e) => {
      if (e.id !== key) return e
      found = true
      return {
        ...e,
        undo: patch.undo !== undefined ? patch.undo : e.undo,
        redo: patch.redo !== undefined ? patch.redo : e.redo
      }
    })
  undoStack = apply(undoStack)
  redoStack = apply(redoStack)
  if (found) persist()
  return found
}

/** 从撤销/复原栈中移除指定条目（用于「撤回本次批量」而不走栈顶） */
export function historyRemoveEntry(id: string): boolean {
  const key = String(id || '')
  if (!key) return false
  const beforeU = undoStack.length
  const beforeR = redoStack.length
  undoStack = undoStack.filter((e) => e.id !== key)
  redoStack = redoStack.filter((e) => e.id !== key)
  if (undoStack.length === beforeU && redoStack.length === beforeR) return false
  persist()
  appendOperation({
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: 'undo',
    label: '撤回指定历史条目',
    detail: { targetId: key }
  })
  return true
}
