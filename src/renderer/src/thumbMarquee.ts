/**
 * 缩略图虚拟列表拖选：按布局几何命中（含滚出视口项）。
 * 与 App 中 thumbVirtual / CSS auto-fill 列计算保持一致。
 */

export type ThumbMarqueeLayout = {
  cols: number
  itemH: number
  gap: number
  pad: number
  /** 可见列表在全量 videos 中的下标 */
  visibleIndices: number[]
  videos: { id: string }[]
}

export function hitTestThumbMarquee(
  layout: ThumbMarqueeLayout,
  grid: { getBoundingClientRect: () => DOMRect; scrollLeft: number; scrollTop: number; clientWidth: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts?: { onlyInPool?: Set<string> }
): Set<string> {
  const { cols, itemH, gap, pad, visibleIndices: indices, videos: list } = layout
  const hit = new Set<string>()
  if (cols < 1 || indices.length === 0) return hit

  const gridRect = grid.getBoundingClientRect()
  const contentLeft = Math.min(x0, x1) - gridRect.left + grid.scrollLeft - pad
  const contentRight = Math.max(x0, x1) - gridRect.left + grid.scrollLeft - pad
  const contentTop = Math.min(y0, y1) - gridRect.top + grid.scrollTop - pad
  const contentBottom = Math.max(y0, y1) - gridRect.top + grid.scrollTop - pad

  const contentW = Math.max(1, grid.clientWidth - pad * 2)
  const cellW = Math.max(1, (contentW - gap * Math.max(0, cols - 1)) / cols)
  const strideX = cellW + gap
  const pool = opts?.onlyInPool

  for (let i = 0; i < indices.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const cellL = col * strideX
    const cellT = row * itemH
    const cellR = cellL + cellW
    const cellB = cellT + itemH - gap
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
