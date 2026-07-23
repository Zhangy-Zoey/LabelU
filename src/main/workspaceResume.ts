import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { WorkspaceResumeSnapshot } from '../shared/labeluApi'

export type { WorkspaceResumeSnapshot }

const RESUME_FILE = (): string => path.join(app.getPath('userData'), 'workspace-resume.json')

function isValidSnapshot(raw: unknown): raw is WorkspaceResumeSnapshot {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as WorkspaceResumeSnapshot
  return (
    o.version === 1 &&
    o.reason === 'post-update' &&
    Array.isArray(o.paths) &&
    o.paths.every((p) => typeof p === 'string' && p.trim().length > 0)
  )
}

export function saveWorkspaceResume(snapshot: WorkspaceResumeSnapshot): void {
  const paths = snapshot.paths.map((p) => String(p || '').trim()).filter(Boolean)
  if (paths.length === 0) {
    clearWorkspaceResume()
    return
  }
  const payload: WorkspaceResumeSnapshot = {
    version: 1,
    reason: 'post-update',
    savedAt: snapshot.savedAt || new Date().toISOString(),
    paths,
    currentPath: snapshot.currentPath ? String(snapshot.currentPath) : null,
    onlyIncomplete:
      typeof snapshot.onlyIncomplete === 'boolean' ? snapshot.onlyIncomplete : undefined,
    mediaKindFilter:
      snapshot.mediaKindFilter === 'video' ||
      snapshot.mediaKindFilter === 'image' ||
      snapshot.mediaKindFilter === 'all'
        ? snapshot.mediaKindFilter
        : undefined
  }
  fs.mkdirSync(path.dirname(RESUME_FILE()), { recursive: true })
  fs.writeFileSync(RESUME_FILE(), JSON.stringify(payload, null, 2), 'utf8')
}

export function peekWorkspaceResume(): WorkspaceResumeSnapshot | null {
  try {
    const raw = fs.readFileSync(RESUME_FILE(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isValidSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 读取并删除快照（一次性恢复，避免下次启动再弹） */
export function consumeWorkspaceResume(): WorkspaceResumeSnapshot | null {
  const snap = peekWorkspaceResume()
  clearWorkspaceResume()
  return snap
}

function clearWorkspaceResume(): void {
  try {
    if (fs.existsSync(RESUME_FILE())) fs.unlinkSync(RESUME_FILE())
  } catch {
    /* ignore */
  }
}
