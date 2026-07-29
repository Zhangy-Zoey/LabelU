/**
 * 缩略图虚拟列表拖选：按布局几何命中（含滚出视口项）。
 * 与 App 中 thumbVirtual 的分行高度布局保持一致。
 */

export type ThumbMarqueeLayout = {
  cols: number
  gap: number
  pad: number
  cellW: number
  /** 每一行顶部 y（内容坐标） */
  rowYs: number[]
  /** 每一行高度（含行底 gap） */
  rowHs: number[]
  /** 可见列表在全量 videos 中的下标 */
  visibleIndices: number[]
  videos: { id: string }[]
}

export function hitTestThumbMarquee(
  layout: ThumbMarqueeLayout,
  grid: {
    getBoundingClientRect: () => DOMRect
    scrollLeft: number
    scrollTop: number
    clientWidth: number
  },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts?: { onlyInPool?: Set<string> }
): Set<string> {
  const { cols, gap, pad, cellW, rowYs, rowHs, visibleIndices: indices, videos: list } = layout
  const hit = new Set<string>()
  if (cols < 1 || indices.length === 0 || cellW <= 0) return hit

  const gridRect = grid.getBoundingClientRect()
  const contentLeft = Math.min(x0, x1) - gridRect.left + grid.scrollLeft - pad
  const contentRight = Math.max(x0, x1) - gridRect.left + grid.scrollLeft - pad
  const contentTop = Math.min(y0, y1) - gridRect.top + grid.scrollTop - pad
  const contentBottom = Math.max(y0, y1) - gridRect.top + grid.scrollTop - pad

  const strideX = cellW + gap
  const pool = opts?.onlyInPool

  for (let i = 0; i < indices.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const rowY = rowYs[row]
    const rowH = rowHs[row]
    if (rowY == null || rowH == null) continue
    const cellL = col * strideX
    const cellT = rowY
    const cellR = cellL + cellW
    const cellB = cellT + rowH - gap
    const overlaps =
      cellL < contentRight &&
      cellR > contentLeft &&
      cellT < contentBottom &&
      cellB > contentTop
    if (!overlaps) continue
    const v = list[indices[i]]
    if (!v) continue
    if (pool && !pool.has(v.id)) continue
    hit.add(v.id)
  }
  return hit
}
