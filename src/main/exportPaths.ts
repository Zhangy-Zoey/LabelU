import path from 'path'
import { isPresetCategory } from '../shared/categories'

/**
 * 导出/整片归类的根目录：
 * 若源文件已在类别文件夹内（二次分类），用其上一级；否则用文件所在目录。
 */
export function exportRootDirFor(sourcePath: string): string {
  const dirPath = path.dirname(path.resolve(sourcePath))
  if (isPresetCategory(path.basename(dirPath))) {
    return path.dirname(dirPath)
  }
  return dirPath
}

/** 源文件是否已在类别文件夹内（可二次分类） */
export function isInCategoryFolder(sourcePath: string): boolean {
  const parent = path.basename(path.dirname(path.resolve(sourcePath)))
  return isPresetCategory(parent)
}

export type ReclassifyDestMode = 'originalRoot' | 'underCurrent' | 'custom'

export type ClassifyDestOptions = {
  /** 二次分类落点；仅当源已在类别目录内时生效，默认 originalRoot */
  reclassifyMode?: ReclassifyDestMode
  /** custom：最终目录（不再套一层类别名） */
  customDestDir?: string
}

/** 解析整片归类目标目录 */
export function resolveClassifyDestDir(
  sourcePath: string,
  category: string,
  opts?: ClassifyDestOptions
): string {
  const resolved = path.resolve(sourcePath)
  const parentDir = path.dirname(resolved)
  const cat = category.trim()
  if (!cat) throw new Error('类别名无效')

  if (!isInCategoryFolder(sourcePath)) {
    return path.join(parentDir, cat)
  }

  const mode = opts?.reclassifyMode ?? 'originalRoot'
  if (mode === 'underCurrent') {
    return path.join(parentDir, cat)
  }
  if (mode === 'custom') {
    const dest = String(opts?.customDestDir || '').trim()
    if (!dest) throw new Error('请选择目标文件夹')
    return path.resolve(dest)
  }
  return path.join(exportRootDirFor(sourcePath), cat)
}
