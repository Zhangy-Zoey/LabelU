import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { clearExceptionLog, appendLog } from './logger'
import { getWhatsNewForVersion, hasWhatsNewEntry } from '../shared/whatsNew'

const STATE_FILE = (): string => path.join(app.getPath('userData'), 'app-version.json')

type VersionState = {
  lastRunVersion?: string
  lastSeenWhatsNewVersion?: string
}

function readState(): VersionState {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8')
    const parsed = JSON.parse(raw) as VersionState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(state: VersionState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true })
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

export type StartupVersionInfo = {
  version: string
  previousVersion: string | null
  upgraded: boolean
  showWhatsNew: boolean
  whatsNewTitle: string
  whatsNewLines: string[]
}

/**
 * 启动时对比版本：
 * - 版本变化 → 覆盖清空异常日志
 * - 尚未看过当前版更新说明 → 标记弹出「更新内容」
 */
export function applyStartupVersionCheck(): StartupVersionInfo {
  const version = app.getVersion()
  const state = readState()
  const previousVersion = state.lastRunVersion?.trim() || null
  const upgraded = Boolean(previousVersion && previousVersion !== version)
  const isFirstRun = !previousVersion

  if (upgraded || isFirstRun) {
    clearExceptionLog(
      upgraded
        ? `overwritten on upgrade ${previousVersion} → ${version}`
        : `initialized for first run ${version}`
    )
  }

  const seenWhatsNew = state.lastSeenWhatsNewVersion === version
  // 开发态不打断调试；正式安装包才弹更新说明
  const showWhatsNew = app.isPackaged && !seenWhatsNew
  const notes = getWhatsNewForVersion(version)
  if (app.isPackaged && showWhatsNew && !hasWhatsNewEntry(version)) {
    appendLog(
      'warn',
      'whatsNew',
      `missing WHATS_NEW entry for version=${version}; falling back to generic copy`
    )
  }

  writeState({
    ...state,
    lastRunVersion: version
    // lastSeenWhatsNewVersion 等用户关闭更新弹窗后再写
  })

  const fallbackLines = upgraded
    ? [`已从 ${previousVersion} 更新到 ${version}。`]
    : isFirstRun
      ? [`欢迎使用 LabelU Video ${version}。`]
      : [`当前版本 ${version}`]

  return {
    version,
    previousVersion,
    upgraded,
    showWhatsNew,
    whatsNewTitle: upgraded
      ? `已更新到 ${version}`
      : isFirstRun
        ? `欢迎使用 LabelU Video ${version}`
        : `LabelU Video ${version}`,
    whatsNewLines: notes.length ? notes : fallbackLines
  }
}

/** 用户关闭「更新内容」后调用，避免同版本反复弹出 */
export function markWhatsNewSeen(version?: string): void {
  const ver = (version || app.getVersion()).trim()
  const state = readState()
  writeState({
    ...state,
    lastRunVersion: state.lastRunVersion || ver,
    lastSeenWhatsNewVersion: ver
  })
}
