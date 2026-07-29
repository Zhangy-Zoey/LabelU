import path from 'path'
import { isPresetCategory } from '../shared/categories'

/**
 * 导出/整片归类的命名根目录：
 * 若源文件已在类别文件夹内，用其上一级；否则用文件所在目录。
 */
export function exportRootDirFor(sourcePath: string): string {
  const dirPath = path.dirname(path.resolve(sourcePath))
  if (isPresetCategory(path.basename(dirPath))) {
    return path.dirname(dirPath)
  }
  return dirPath
}

export type ClassifyDestOptions = {
  /** 类别文件夹的源目录，实际写入 {customDestDir}/{category}/ */
  customDestDir?: string
}

/**
 * 解析整片归类 / 片段导出目标目录。
 * 优先用 customDestDir；缺省时回退到源文件旁的命名根（兼容旧操作历史）。
 */
export function resolveClassifyDestDir(
  sourcePath: string,
  category: string,
  opts?: ClassifyDestOptions
): string {
  const cat = category.trim()
  if (!cat) throw new Error('类别名无效')
  const root =
    String(opts?.customDestDir || '').trim() || exportRootDirFor(sourcePath)
  return path.join(path.resolve(root), cat)
}
