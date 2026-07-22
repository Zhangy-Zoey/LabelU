/**
 * 各版本更新说明。
 * 发版时必须：
 * 1. 修改 package.json 的 version
 * 2. 在本文件 WHATS_NEW 中增加同名字条目
 * （`npm run build` / dist / release 会跑 scripts/check-whats-new.js 校验）
 */
export const WHATS_NEW: Record<string, string[]> = {
  '1.0.0': [
    '支持视频 / 图片剪辑与按类别导出',
    '整段批量归类；已归类文件可二次分类并选择落点',
    '完成标记写入源文件名 `_done`（不另建旁路文件）',
    '异常自动写入单一日志；可在界面查看',
    '支持 GitHub Releases 自动更新（各平台只下载本平台安装包）'
  ]
}

/** 是否已为该版本编写更新说明 */
export function hasWhatsNewEntry(version: string): boolean {
  const key = String(version || '').trim()
  return Array.isArray(WHATS_NEW[key]) && WHATS_NEW[key].length > 0
}

/** 取某一版本的更新要点；无条目时返回空数组 */
export function getWhatsNewForVersion(version: string): string[] {
  const key = String(version || '').trim()
  const lines = WHATS_NEW[key]
  return Array.isArray(lines) ? lines.map((s) => String(s)) : []
}
