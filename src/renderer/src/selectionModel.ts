import type { ExportRecord, TimeRange } from '../../shared/types'
import {
  clamp,
  formatMinSelectionSeconds,
  formatTime,
  minSelectionGap,
  resolveClipSelection,
  selectionTolerance
} from '../../shared/utils'

export type EdgeMoveResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: string }

export function exportBlockingSelection(
  start: number,
  end: number,
  clipExports: ExportRecord[]
): ExportRecord | null {
  const a = Math.min(start, end)
  const b = Math.max(start, end)
  return (
    clipExports.find((e) => !e.approx && a < e.end - 0.02 && b > e.start + 0.02) ?? null
  )
}

export function explainPointerOutsideRemaining(
  pointerTime: number,
  remaining: TimeRange[],
  clipExports: ExportRecord[]
): string {
  const hitExp = clipExports.find(
    (e) => !e.approx && pointerTime >= e.start - 0.02 && pointerTime <= e.end + 0.02
  )
  if (hitExp) {
    return `指针落在已分类片段「${hitExp.category}」（${formatTime(hitExp.start)}–${formatTime(hitExp.end)}），请拖到未分类灰色区域`
  }
  if (remaining.length === 0) return '没有可剪的未分类时段'
  return '指针不在可剪的未分类时段内'
}

/**
 * 拖动/微调入出点：拖出点时锁定入点，拖入点时锁定出点；仅拖入点可跨剩余段跳转。
 */
export function tryMoveSelectionEdge(
  which: 'in' | 'out',
  pointerTime: number,
  liveStart: number,
  liveEnd: number,
  remaining: TimeRange[],
  stepFps: number,
  clipExports: ExportRecord[],
  sourceFps: number
): EdgeMoveResult {
  const tol = selectionTolerance(stepFps)
  let ns = Math.min(liveStart, liveEnd)
  let ne = Math.max(liveStart, liveEnd)

  const ptrHost =
    remaining.find((r) => pointerTime >= r.start - tol && pointerTime <= r.end + tol) ?? null
  if (!ptrHost || !(ptrHost.end > ptrHost.start)) {
    return {
      ok: false,
      reason: explainPointerOutsideRemaining(pointerTime, remaining, clipExports)
    }
  }

  if (which === 'in') {
    const neHost =
      remaining.find((r) => ne >= r.start - tol && ne <= r.end + tol) ?? null
    if (neHost && neHost !== ptrHost) {
      const lo = ptrHost.start
      const hi = ptrHost.end
      const minGap = minSelectionGap(hi - lo, sourceFps)
      const floorGap = minSelectionGap(Number.POSITIVE_INFINITY, sourceFps)
      const prefer = Math.min(Math.max(minGap, ne - ns, floorGap), hi - lo)
      ns = clamp(pointerTime, lo, Math.max(lo, hi - minGap))
      ne = clamp(ns + prefer, ns + minGap, hi)
    } else {
      const host = ptrHost
      const lo = host.start
      const hi = host.end
      const minGap = minSelectionGap(hi - lo, sourceFps)
      ns = clamp(pointerTime, lo, Math.max(lo, ne - minGap))
      if (ne - ns < minGap - 1e-6) ns = Math.max(lo, ne - minGap)
    }
  } else {
    const nsHost =
      remaining.find((r) => ns >= r.start - tol && ns <= r.end + tol) ?? null
    if (!nsHost) {
      return { ok: false, reason: '入点不在可剪区域内，请先调整入点' }
    }
    if (nsHost !== ptrHost) {
      return {
        ok: false,
        reason: explainPointerOutsideRemaining(pointerTime, remaining, clipExports)
      }
    }
    const lo = nsHost.start
    const hi = nsHost.end
    const minGap = minSelectionGap(hi - lo, sourceFps)
    ne = clamp(pointerTime, Math.min(hi, ns + minGap), hi)
    if (ne - ns < minGap - 1e-6) ne = Math.min(hi, ns + minGap)
  }

  const edgeHost =
    remaining.find((r) => ns >= r.start - tol && ne <= r.end + tol) ?? ptrHost
  const edgeMinGap = minSelectionGap(edgeHost.end - edgeHost.start, sourceFps)
  if (ne - ns < edgeMinGap - 1e-6) {
    return {
      ok: false,
      reason: `选区不能短于 ${formatMinSelectionSeconds(edgeMinGap)} 秒（当前可剪时段过短或入/出点过近）`
    }
  }

  const hit = exportBlockingSelection(ns, ne, clipExports)
  if (hit) {
    return {
      ok: false,
      reason: `选区与已分类片段「${hit.category}」（${formatTime(hit.start)}–${formatTime(hit.end)}）重叠`
    }
  }

  return { start: ns, end: ne, ok: true }
}

export function validateSelectionRange(
  start: number,
  end: number,
  remaining: TimeRange[],
  clipExports: ExportRecord[],
  stepFps: number,
  sourceFps: number
): EdgeMoveResult {
  const result = resolveClipSelection(start, end, remaining, clipExports, stepFps, sourceFps)
  if (!result.ok) return { ok: false, reason: result.reason }
  return { ok: true, start: result.start, end: result.end }
}
