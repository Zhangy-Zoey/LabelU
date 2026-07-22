import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { VideoItem } from '../shared/types'
import { MEDIA_EXTENSIONS, mediaKindFromPath } from '../shared/types'
import { isPresetCategory } from '../shared/categories'
import {
  sanitizeName,
  isClipExportFileName,
  isCompletedFileName
} from '../shared/utils'
import {
  isSourceClassified,
  listCategoryExportFiles,
  listCategoryDirectories,
  beginCategoryScanCache,
  endCategoryScanCache
} from './session'
import { exportRootDirFor } from './exportPaths'

function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 仅当上级目录名属于「指定类别标签」（预设或用户手动添加的三大类标签）时，视为已归类整片。
 * 普通子文件夹名不在标签列表中 → 不算已归类。
 */
function detectCategorizedPlacement(filePath: string): boolean {
  const parentName = path.basename(path.dirname(filePath))
  return isPresetCategory(parentName)
}

/**
 * 裁剪导出的片段：位于类别目录，且文件名符合
 * `{源目录}_{源文件名}_{序号}.ext` 或带时段 `{…}_{序号}_s{ms}_e{ms}.ext`
 * 扫描源文件夹时跳过，避免导出件混进待处理列表；
 * 用户显式拖入该文件 / 类别文件夹时仍应可导入工作区。
 */
function isClipExportArtifact(filePath: string): boolean {
  const parent = path.basename(path.dirname(filePath))
  if (!isPresetCategory(parent)) return false
  const grandParent = sanitizeName(path.basename(path.dirname(path.dirname(filePath))))
  const base = path.basename(filePath)
  if (!base.startsWith(`${grandParent}_`)) return false
  return isClipExportFileName(base)
}

/** 顶层导入路径是否应保留导出片段（显式文件，或直接打开类别目录） */
function shouldAllowClipExportsAtRoot(rootPath: string, isDirectory: boolean): boolean {
  if (!isDirectory) return true
  return isPresetCategory(path.basename(path.resolve(rootPath)))
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export type ScanOptions = {
  /** 为 true 时用轻量完成判定（导入大文件/大文件夹时） */
  fastCompleted?: boolean
  isCancelled?: () => boolean
  onProgress?: (message: string) => void
}

/**
 * 异步扫描：stat/readdir 走线程池，主进程可继续泵消息，Windows 大文件不再「未响应」。
 */
export async function scanPathsAsync(
  inputPaths: string[],
  opts: ScanOptions = {}
): Promise<VideoItem[]> {
  const files: string[] = []
  const seen = new Set<string>()
  const fast = opts.fastCompleted === true
  let visited = 0

  async function walk(p: string, allowClipExports: boolean): Promise<void> {
    if (opts.isCancelled?.()) return
    let st: fs.Stats
    try {
      st = await fs.promises.stat(p)
    } catch {
      return
    }
    visited++
    if (visited % 8 === 0) {
      opts.onProgress?.(`正在扫描…（已发现 ${files.length} 个媒体）`)
      await yieldEventLoop()
      if (opts.isCancelled?.()) return
    }

    if (st.isFile()) {
      if (isMediaFile(p) && !p.includes('.labelu.tmp') && !p.endsWith('.labelu.bak')) {
        const abs = path.resolve(p)
        if (!allowClipExports && isClipExportArtifact(abs)) return
        if (!seen.has(abs)) {
          seen.add(abs)
          files.push(abs)
        }
      }
      return
    }
    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = await fs.promises.readdir(p)
      } catch {
        return
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue
        if (opts.isCancelled?.()) return
        await walk(path.join(p, name), allowClipExports)
      }
    }
  }

  if (!fast) beginCategoryScanCache()
  try {
    for (const p of inputPaths) {
      if (opts.isCancelled?.()) break
      opts.onProgress?.(`正在导入：${path.basename(p)}`)
      let st: fs.Stats
      try {
        st = await fs.promises.stat(p)
      } catch {
        continue
      }
      await walk(p, shouldAllowClipExportsAtRoot(p, st.isDirectory()))
    }
    if (opts.isCancelled?.()) {
      throw new Error('已取消')
    }
    files.sort((a, b) => a.localeCompare(b, 'zh'))
    const items: VideoItem[] = []
    // 快速导入：跳过逐文件 existsSync，completed 交后台 refreshCompletedFlags
    for (let i = 0; i < files.length; i++) {
      if (i % 40 === 0) {
        opts.onProgress?.(`正在整理列表…（${i}/${files.length}）`)
        await yieldEventLoop()
      }
      items.push(toVideoItem(files[i], fast ? 'defer' : 'full'))
    }
    return items
  } finally {
    if (!fast) endCategoryScanCache()
  }
}

type CompletedMode = 'full' | 'defer'

function toVideoItem(filePath: string, completedMode: CompletedMode): VideoItem {
  const dirPath = path.dirname(filePath)
  // defer：导入大批量时先不查盘，避免 Windows 杀软对每个小文件 existsSync 卡死
  const classified = completedMode === 'full' ? isSourceClassified(filePath) : false
  return {
    id: randomUUID(),
    path: filePath,
    name: path.basename(filePath),
    parentDirName: path.basename(dirPath),
    dirPath,
    completed: classified,
    isCategoryCopy: detectCategorizedPlacement(filePath),
    mediaKind: mediaKindFromPath(filePath) ?? 'video'
  }
}

/**
 * 大批量导入用：按源父目录去重，只收集类别文件夹路径（不再对每个视频 readdir）。
 * 调用方把返回路径写入白名单即可。
 */
export async function collectCategoryWhitelistPathsAsync(
  videos: { path: string }[],
  opts?: { isCancelled?: () => boolean; onProgress?: (message: string) => void }
): Promise<string[]> {
  beginCategoryScanCache()
  try {
    const parentDirs = new Set<string>()
    for (let i = 0; i < videos.length; i++) {
      if (opts?.isCancelled?.()) break
      const p = videos[i]?.path
      if (p) parentDirs.add(exportRootDirFor(p))
      if (i % 64 === 0) await yieldEventLoop()
    }

    const out: string[] = []
    let done = 0
    const dirs = Array.from(parentDirs)
    for (const dir of dirs) {
      if (opts?.isCancelled?.()) break
      opts?.onProgress?.(`正在登记类别目录…（${done + 1}/${dirs.length}）`)
      try {
        for (const catDir of listCategoryDirectories(dir)) {
          out.push(catDir)
        }
      } catch {
        /* ignore */
      }
      done++
      if (done % 2 === 0) await yieldEventLoop()
    }
    return out
  } finally {
    endCategoryScanCache()
  }
}

/** 后台补全「已完成」标记（导入时为防卡顿跳过了逐文件查盘） */
export async function refreshCompletedFlags(
  videos: VideoItem[],
  opts?: { isCancelled?: () => boolean; onProgress?: (message: string) => void }
): Promise<VideoItem[]> {
  beginCategoryScanCache()
  try {
    // 先按父目录预热类别扫描缓存，避免后面每个视频首次 readdir
    const parents = new Set<string>()
    for (const v of videos) {
      if (v?.path) parents.add(exportRootDirFor(v.path))
    }
    let warmed = 0
    for (const dir of Array.from(parents)) {
      if (opts?.isCancelled?.()) break
      try {
        listCategoryDirectories(dir)
      } catch {
        /* ignore */
      }
      warmed++
      if (warmed % 2 === 0) await yieldEventLoop()
    }

    const next = [...videos]
    const concurrency = 8
    for (let i = 0; i < next.length; i += concurrency) {
      if (opts?.isCancelled?.()) break
      opts?.onProgress?.(`正在识别已完成…（${i}/${next.length}）`)
      const slice = next.slice(i, i + concurrency)
      await Promise.all(
        slice.map(async (v, offset) => {
          if (v.completed) return
          try {
            if (await isSourceClassifiedAsync(v.path)) {
              next[i + offset] = { ...v, completed: true }
            }
          } catch {
            /* ignore */
          }
        })
      )
      await yieldEventLoop()
    }
    return next
  } finally {
    endCategoryScanCache()
  }
}

async function pathExistsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

/** 异步版：exists 走线程池，避免 Windows 大批量 existsSync 堵死主进程 */
async function isSourceClassifiedAsync(sourcePath: string): Promise<boolean> {
  if (isCompletedFileName(sourcePath)) return true
  if (await pathExistsAsync(sourcePath + '.labelu.done')) return true
  if (await pathExistsAsync(sourcePath + '.labelu.json')) return true
  // 类别目录列表已缓存时仅为内存前缀匹配
  return listCategoryExportFiles(sourcePath).length > 0
}
