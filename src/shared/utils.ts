import type { CropRect, TimeRange } from './types'
import { MIN_SELECTION_SECONDS } from './types'

/** Remove [cutStart, cutEnd] from a list of remaining ranges. */
function subtractRange(ranges: TimeRange[], cutStart: number, cutEnd: number): TimeRange[] {
  const result: TimeRange[] = []
  for (const r of ranges) {
    if (cutEnd <= r.start || cutStart >= r.end) {
      result.push({ ...r })
      continue
    }
    if (cutStart > r.start) {
      result.push({ start: r.start, end: cutStart })
    }
    if (cutEnd < r.end) {
      result.push({ start: cutEnd, end: r.end })
    }
  }
  return mergeRanges(result)
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: TimeRange[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    const cur = sorted[i]
    if (cur.start <= last.end + 0.001) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

export function totalDuration(ranges: TimeRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)
}

/** 选区与剩余段边界容差（秒） */
export const SELECTION_TOLERANCE = 0.05

/** 入出点最小间距（秒）；与步进 fps 无关 */
export function minSelectionGap(hostLen: number): number {
  const host = Math.max(0, hostLen)
  if (host <= 0) return MIN_SELECTION_SECONDS
  return Math.min(host, MIN_SELECTION_SECONDS)
}

export function selectionTolerance(stepFps: number): number {
  return Math.max(SELECTION_TOLERANCE, frameDuration(stepFps) * 0.5)
}

export type SelectionValidateResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: string; suggested?: { start: number; end: number } }

type ExportSpan = { start: number; end: number; approx?: boolean; category?: string }

/** 选区是否落在可剪剩余段内（前后端共用） */
export function validateClipSelection(
  start: number,
  end: number,
  remaining: TimeRange[],
  exports: ExportSpan[],
  stepFps = 25
): SelectionValidateResult {
  const a = snapToFrame(Math.min(start, end), stepFps)
  let b = snapToFrame(Math.max(start, end), stepFps)
  const tol = selectionTolerance(stepFps)
  let host =
    remaining.find((r) => a >= r.start - tol && b <= r.end + tol) ?? null
  if (!host) {
    // 入点在段内、出点因吸附略超出段尾时收紧出点，避免误报
    for (const r of remaining) {
      if (a < r.start - tol || a > r.end + tol) continue
      if (b > r.end + tol) {
        b = snapToFrame(Math.min(b, r.end), stepFps, 'floor')
      }
      if (b >= a - 1e-6 && b <= r.end + tol) {
        host = r
        break
      }
    }
  }
  if (!host) {
    const suggested = clampSelectionToRemaining(a, b, remaining, stepFps)
    return {
      ok: false,
      reason: '选区超出可剪的未分类时段',
      suggested: suggested ?? undefined
    }
  }
  const minGap = minSelectionGap(host.end - host.start)
  if (b - a < minGap - 1e-6) {
    return { ok: false, reason: `选区不能短于 ${MIN_SELECTION_SECONDS} 秒` }
  }
  const hit = exports.find(
    (e) => !e.approx && a < e.end - tol && b > e.start + tol
  )
  if (hit) {
    const cat = hit.category || '未命名'
    return {
      ok: false,
      reason: `选区与已分类片段「${cat}」（${formatTime(hit.start)}–${formatTime(hit.end)}）重叠`
    }
  }
  return { ok: true, start: a, end: b }
}

/** 将选区对齐到可剪剩余段；失败时返回原因与建议值 */
export function resolveClipSelection(
  start: number,
  end: number,
  remaining: TimeRange[],
  exports: ExportSpan[],
  stepFps = 25
): SelectionValidateResult {
  const check = validateClipSelection(start, end, remaining, exports, stepFps)
  if (check.ok) return check
  const suggested =
    check.suggested ?? clampSelectionToRemaining(start, end, remaining, stepFps)
  if (!suggested) return check
  const again = validateClipSelection(
    suggested.start,
    suggested.end,
    remaining,
    exports,
    stepFps
  )
  if (again.ok) return again
  return check
}

/** 将选区吸附到最近的可剪剩余段 */
export function clampSelectionToRemaining(
  start: number,
  end: number,
  remaining: TimeRange[],
  stepFps: number
): { start: number; end: number } | null {
  if (remaining.length === 0) return null
  let a = Math.min(start, end)
  let b = Math.max(start, end)
  const len = Math.max(MIN_SELECTION_SECONDS, b - a)
  const mid = (a + b) / 2
  let host =
    remaining.find((r) => a >= r.start - 0.05 && b <= r.end + 0.05) ??
    remaining.find((r) => mid >= r.start && mid <= r.end) ??
    remaining[0]
  if (!host) return null
  const minGap = minSelectionGap(host.end - host.start)
  const useLen = Math.min(Math.max(len, minGap), host.end - host.start)
  let ns = clamp(a, host.start, Math.max(host.start, host.end - useLen))
  let ne = ns + useLen
  if (ne > host.end + 1e-6) {
    ne = host.end
    ns = Math.max(host.start, ne - useLen)
  }
  return {
    start: snapToFrame(ns, stepFps),
    end: snapToFrame(ne, stepFps)
  }
}

/** 以片长与已导出片段为准，重算剩余可剪区间（主进程权威） */
export function computeRemainingFromExports(
  duration: number,
  exports: { start: number; end: number }[]
): TimeRange[] {
  const dur = Math.max(0, duration)
  let ranges: TimeRange[] = dur > 0 ? [{ start: 0, end: dur }] : []
  const sorted = [...exports].sort((a, b) => a.start - b.start)
  for (const e of sorted) {
    const a = Math.min(e.start, e.end)
    const b = Math.max(e.start, e.end)
    if (b - a < 0.001) continue
    ranges = subtractRange(ranges, a, b)
  }
  return ranges
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 一帧时长（秒）。fps=步进：1→每秒1帧，8→每秒8帧（按8下←→=1秒） */
export function frameDuration(fps: number): number {
  // 步进允许为 1；旧条件 fps>1 会把步进1错误回退成 25（看起来像约24fps）
  const f = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 25
  return 1 / f
}

/** 将时间吸附到最近帧边界 */
export function snapToFrame(
  time: number,
  fps: number,
  mode: 'round' | 'floor' | 'ceil' = 'round'
): number {
  const f = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 25
  if (!Number.isFinite(time)) return 0
  const idx = time * f
  const frame =
    mode === 'floor' ? Math.floor(idx + 1e-9) : mode === 'ceil' ? Math.ceil(idx - 1e-9) : Math.round(idx)
  return Math.max(0, frame / f)
}

export function frameIndex(time: number, fps: number): number {
  const f = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 25
  return Math.round(snapToFrame(time, fps) * f)
}

/** 按步进前进/后退若干格（步进 fps：1格=1/fps 秒） */
export function stepByFrames(time: number, fps: number, deltaFrames: number): number {
  const f = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 25
  return Math.max(0, (frameIndex(time, f) + deltaFrames) / f)
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  if (h > 0) {
    const base = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return ms > 0 ? `${base}.${ms}` : base
  }
  const base = `${m}:${String(s).padStart(2, '0')}`
  return ms > 0 ? `${base}.${ms}` : base
}

/** 时间码（按步进 fps）；省略前导 0 与无意义的尾零 */
export function formatTimecode(seconds: number, fps: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const f = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 25
  const roundedF = Math.round(f)
  const totalFrames = Math.max(0, frameIndex(seconds, f))
  const ff = roundedF > 1 ? totalFrames % roundedF : 0
  const totalSeconds = Math.floor(totalFrames / f)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60

  if (h > 0) {
    let base = `${h}:${String(m).padStart(2, '0')}`
    if (s > 0 || ff > 0) base += `:${String(s).padStart(2, '0')}`
    return ff > 0 ? `${base}:${String(ff).padStart(2, '0')}` : base
  }
  if (m > 0) {
    const base = `${m}:${String(s).padStart(2, '0')}`
    return ff > 0 ? `${base}:${String(ff).padStart(2, '0')}` : base
  }
  if (ff > 0) return `${s}:${String(ff).padStart(2, '0')}`
  return String(s)
}

/** 时间轴底部时间显示：始终保留一位小数 */
export function formatTimelineTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.0'
  const t = Math.round(seconds * 10) / 10
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.round((t - h * 3600 - m * 60) * 10) / 10
  const sStr = s.toFixed(1)
  const secPart = s < 10 ? `0${sStr}` : sStr
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${secPart}`
  if (m > 0) return `${m}:${secPart}`
  return sStr
}

export function sanitizeName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  // 禁止路径穿越与空名（否则 path.join(dir, '..') 会写出父目录）
  if (!s || s === '.' || s === '..') return 'unnamed'
  if (s.includes('..')) s = s.replace(/\.\.+/g, '_')
  // Windows 不允许尾部点/空格；两端都清，避免跨平台导出目录异常
  s = s.replace(/^[.\s]+|[.\s]+$/g, '').trim()
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1/LPT1…）无法作为文件或文件夹名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) {
    s = `_${s}`
  }
  return s || 'unnamed'
}

function pathBasename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || filePath
}

export function pathStem(filePath: string): string {
  const base = pathBasename(filePath)
  const idx = base.lastIndexOf('.')
  return idx >= 0 ? base.slice(0, idx) : base
}

/** 已完成标记：写在源文件名上（stem 末尾 `_done`），不另建旁路文件 */
export const COMPLETED_NAME_SUFFIX = '_done'

export function isCompletedFileName(filePath: string): boolean {
  const stem = pathStem(filePath)
  return stem.length > COMPLETED_NAME_SUFFIX.length && stem.endsWith(COMPLETED_NAME_SUFFIX)
}

/** 去掉完成后缀后的 stem，供导出文件名 / 回看匹配使用 */
export function sourceStemForExport(filePath: string): string {
  const stem = pathStem(filePath)
  if (stem.length > COMPLETED_NAME_SUFFIX.length && stem.endsWith(COMPLETED_NAME_SUFFIX)) {
    return stem.slice(0, -COMPLETED_NAME_SUFFIX.length)
  }
  return stem
}

export function withCompletedFileName(filePath: string): string {
  if (isCompletedFileName(filePath)) return filePath
  const base = pathBasename(filePath)
  const idx = base.lastIndexOf('.')
  const stem = idx >= 0 ? base.slice(0, idx) : base
  const ext = idx >= 0 ? base.slice(idx) : ''
  const dir = filePath.slice(0, Math.max(0, filePath.length - base.length))
  return `${dir}${stem}${COMPLETED_NAME_SUFFIX}${ext}`
}

export function withoutCompletedFileName(filePath: string): string {
  if (!isCompletedFileName(filePath)) return filePath
  const base = pathBasename(filePath)
  const idx = base.lastIndexOf('.')
  const stem = idx >= 0 ? base.slice(0, idx) : base
  const ext = idx >= 0 ? base.slice(idx) : ''
  const dir = filePath.slice(0, Math.max(0, filePath.length - base.length))
  return `${dir}${stem.slice(0, -COMPLETED_NAME_SUFFIX.length)}${ext}`
}

/**
 * 裁剪导出文件名：
 * - 无画面裁切：`{prefix}{N}_s{startMs}_e{endMs}_{类别}.mp4`
 * - 有画面裁切：`…_{类别}_c{x}_{y}_{w}_{h}.mp4`（归一化 0–1 ×10000）
 * 仍保存在「类别」子目录中；文件名即可复原时间轴与裁切框，无需 .labelu.json。
 */
export function formatClipExportFileName(
  prefix: string,
  index: number,
  category: string,
  start: number,
  end: number,
  crop?: CropRect | null,
  ext = '.mp4'
): string {
  const cat = sanitizeName(category)
  const sMs = Math.max(0, Math.round(start * 1000))
  const eMs = Math.max(sMs + 1, Math.round(end * 1000))
  const e = ext.startsWith('.') ? ext : `.${ext}`
  const cropSuffix = crop && isMeaningfulCrop(crop) ? `_${encodeCropSuffix(crop)}` : ''
  return `${prefix}${index}_s${sMs}_e${eMs}_${cat}${cropSuffix}${e}`
}

/** 裁切是否相对全幅有意义（与 UI「裁切开启」一致） */
export function isMeaningfulCrop(crop: CropRect | null | undefined): boolean {
  if (!crop) return false
  const near = (a: number, b: number) => Math.abs(a - b) < 0.002
  return !(near(crop.x, 0) && near(crop.y, 0) && near(crop.width, 1) && near(crop.height, 1))
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** 归一化裁切 → `cX_Y_W_H`（万分比整数） */
export function encodeCropSuffix(crop: CropRect): string {
  const q = (n: number) => Math.round(clamp01(n) * 10000)
  return `c${q(crop.x)}_${q(crop.y)}_${q(crop.width)}_${q(crop.height)}`
}

export function decodeCropSuffix(token: string): CropRect | null {
  const m = /^c(\d+)_(\d+)_(\d+)_(\d+)$/i.exec(token.trim())
  if (!m) return null
  const x = parseInt(m[1], 10) / 10000
  const y = parseInt(m[2], 10) / 10000
  const width = parseInt(m[3], 10) / 10000
  const height = parseInt(m[4], 10) / 10000
  if (!(width > 0) || !(height > 0)) return null
  if (x + width > 1.001 || y + height > 1.001) return null
  return { x, y, width, height }
}

export type ClipExportNameMeta = {
  index: number
  start: number
  end: number
  /** 文件名中的类别；旧版无类别后缀时为 null */
  category: string | null
  crop?: CropRect | null
}

/**
 * 从导出文件名解析序号 / 入出点 / 类别 / 裁切。
 * 兼容：
 * - `…_N_s…_e…_{类别}[_c…].mp4`（当前）
 * - `…_N_s…_e….mp4`（仅时段）
 */
export function parseClipExportMeta(fileName: string): ClipExportNameMeta | null {
  const base = pathBasename(fileName)
  // 当前：…_1_s12340_e45678_吃饭.mp4 或 …_吃饭_c1000_2000_5000_6000.mp4
  let m = base.match(/_(\d+)_s(\d+)_e(\d+)_(.+)\.[^.]+$/i)
  if (m) {
    const index = parseInt(m[1], 10)
    const start = parseInt(m[2], 10) / 1000
    const end = parseInt(m[3], 10) / 1000
    let rest = m[4].trim()
    let crop: CropRect | null = null
    const cropTail = rest.match(/^(.*)_((c\d+_\d+_\d+_\d+))$/i)
    if (cropTail) {
      const decoded = decodeCropSuffix(cropTail[2])
      if (decoded) {
        rest = cropTail[1].trim()
        crop = decoded
      }
    }
    if (Number.isFinite(index) && rest && end > start) {
      return { index, start, end, category: rest, crop }
    }
  }
  // 仅时段：…_1_s12340_e45678.mp4
  m = base.match(/_(\d+)_s(\d+)_e(\d+)\.[^.]+$/i)
  if (m) {
    const index = parseInt(m[1], 10)
    const start = parseInt(m[2], 10) / 1000
    const end = parseInt(m[3], 10) / 1000
    if (Number.isFinite(index) && end > start) {
      return { index, start, end, category: null, crop: null }
    }
  }
  return null
}

/** 解析导出序号（兼容旧名与带类别/时段的新名） */
export function parseClipExportIndex(fileName: string, prefix: string): number | null {
  const base = pathBasename(fileName)
  if (!base.startsWith(prefix)) return null
  const mid = base.slice(prefix.length)
  const m = mid.match(/^(\d+)(?:_.+)?\./i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/** 是否为裁剪导出件文件名（类别目录内） */
export function isClipExportFileName(fileName: string): boolean {
  const base = pathBasename(fileName)
  if (parseClipExportMeta(base)) return true
  return /_\d+\.[^.]+$/i.test(base)
}
