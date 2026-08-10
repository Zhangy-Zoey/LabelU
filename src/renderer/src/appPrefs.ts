/** 渲染进程 localStorage 偏好（跨重启） */

export const LS_THUMB = 'labelu.thumbSize'
export const LS_SIDEBAR = 'labelu.sidebarWidth'
export const LS_STEP_FPS = 'labelu.stepFps'
export const LS_TIMELINE_ZOOM = 'labelu.timelineZoomOnSelect'
export const LS_LOOP_SELECTION = 'labelu.loopSelection'
export const LS_PLAYBACK_RATE = 'labelu.playbackRate'
export const LS_ONLY_INCOMPLETE = 'labelu.onlyIncomplete'
export const LS_SAVE_ROOT = 'labelu.categorySaveRoot'
export const LS_FILMSTRIP_HEIGHT = 'labelu.filmstripHeight'
/** 导入后后台预生成 HEVC 兼容预览 */
export const LS_HEVC_PREWARM = 'labelu.hevcPrewarm'

export const STEP_FPS_DEFAULT = 8

export function loadStoredBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
  } catch {
    /* ignore */
  }
  return fallback
}

export function loadStoredNumber(
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  try {
    const n = Number(localStorage.getItem(key))
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n))
  } catch {
    /* ignore */
  }
  return fallback
}

export function loadStepFps(): number {
  const allowed = [1, 8, 16, 22]
  const raw = loadStoredNumber(LS_STEP_FPS, STEP_FPS_DEFAULT, 1, 120)
  if (allowed.includes(raw)) return raw
  return allowed.reduce((best, opt) =>
    Math.abs(opt - raw) < Math.abs(best - raw) ? opt : best
  )
}

export function loadStoredPlaybackRate(): number {
  const allowed = [0.5, 1, 2, 4]
  const raw = loadStoredNumber(LS_PLAYBACK_RATE, 1, 0.25, 8)
  return allowed.includes(raw) ? raw : 1
}

export function persistBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function persistNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* ignore */
  }
}

export function loadPersistedSaveRoot(): string {
  try {
    return (localStorage.getItem(LS_SAVE_ROOT) || '').trim()
  } catch {
    /* ignore */
  }
  return ''
}

export function persistSaveRoot(root: string): void {
  try {
    const r = root.trim()
    if (r) localStorage.setItem(LS_SAVE_ROOT, r)
  } catch {
    /* ignore */
  }
}
