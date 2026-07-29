import type { CropRect } from '../../shared/types'
import type { OpUiTimelineState } from '../../shared/opTypes'

export async function pushOpHistory(payload: {
  kind: import('../../shared/opTypes').OpKind
  label: string
  undo: unknown
  redo: unknown
  detail?: unknown
}): Promise<import('../../shared/opTypes').OpHistoryEntry | null> {
  try {
    const r = await window.api.opHistoryPush(payload)
    return r?.entry ?? null
  } catch (err) {
    console.error('[labelu] opHistoryPush', err)
    return null
  }
}

/** 仅记操作日志、不进撤销栈 */
export async function logOp(kind: string, label: string, detail?: unknown): Promise<void> {
  try {
    await window.api.opHistoryLog({ kind, label, detail })
  } catch (err) {
    console.error('[labelu] opHistoryLog', err)
  }
}

export async function patchOpHistory(
  id: string,
  patch: { undo?: unknown; redo?: unknown }
): Promise<boolean> {
  try {
    const r = await window.api.opHistoryPatch({ id, ...patch })
    return Boolean(r?.ok)
  } catch (err) {
    console.error('[labelu] opHistoryPatch', err)
    return false
  }
}

export type UiSnapshotInput = {
  sourcePath: string
  selStart: number
  selEnd: number
  fineTuneWhich: 'in' | 'out' | null
  markers: { id: string; time: number }[]
  crop: CropRect
  cropActive: boolean
  selectedIds: Iterable<string>
  secondaryIds: Iterable<string>
}

export function snapshotUi(input: UiSnapshotInput): OpUiTimelineState {
  return {
    sourcePath: input.sourcePath,
    selStart: input.selStart,
    selEnd: input.selEnd,
    fineTuneWhich: input.fineTuneWhich,
    markers: input.markers.map((m) => ({ ...m })),
    crop: { ...input.crop },
    cropActive: input.cropActive,
    selectedIds: Array.from(input.selectedIds),
    secondaryIds: Array.from(input.secondaryIds)
  }
}
