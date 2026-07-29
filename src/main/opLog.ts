import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { OpLogEntry } from '../shared/opTypes'

const OP_LOG_NAME = 'operations.log'

function logDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

export function getOperationsLogPath(): string {
  return path.join(logDir(), OP_LOG_NAME)
}

function ensureDir(): void {
  fs.mkdirSync(logDir(), { recursive: true })
}

export function initOpLog(): void {
  try {
    ensureDir()
    const file = getOperationsLogPath()
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 追加一条操作日志（JSONL），只增不删。
 * 撤销/复原会另写新行，绝不抹掉原操作记录；也不提供清空/裁剪。
 */
export function appendOperation(entry: OpLogEntry): void {
  try {
    ensureDir()
    const file = getOperationsLogPath()
    const line = `${JSON.stringify(entry)}\n`
    fs.appendFileSync(file, line, 'utf8')
  } catch {
    /* 操作日志失败不得影响主流程 */
  }
}

export function openOperationsLog(): Promise<{ ok: boolean; path: string; error?: string }> {
  const file = getOperationsLogPath()
  return (async () => {
    try {
      ensureDir()
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
      const { shell } = await import('electron')
      const err = await shell.openPath(file)
      if (err) {
        await shell.openPath(path.dirname(file))
        return { ok: false, path: file, error: err }
      }
      return { ok: true, path: file }
    } catch (e) {
      return {
        ok: false,
        path: file,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })()
}
