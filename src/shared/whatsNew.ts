/**
 * 各版本更新说明。
 * 发版时必须：
 * 1. 修改 package.json 的 version
 * 2. 在本文件 WHATS_NEW 中增加同名字条目
 * （`npm run build` / dist / release 会跑 scripts/check-whats-new.js 校验）
 */
export const WHATS_NEW: Record<string, string[]> = {
  '1.0.4': [
    '检查更新与下载改为国内可访问的镜像源（generic），显著加快更新与安装包下载',
    '修复「重启安装」无法退出应用的问题；未签名包安装流程更可靠',
    '支持用环境变量 LABELU_UPDATE_URL 或本地 update-feed-url.txt 指向自建 OSS/CDN'
  ],
  '1.0.3': [
    '多选后可开启「二次选择」：从已选项中再挑目标做批量分类，不打断小窗播放、不切主预览',
    '缩略图支持拖选框选（含滚出视口项）；播放中可继续点选/拖选',
    'Windows：修复 HEVC 兼容预览临时文件扩展名导致无法生成；代理最多两路并行并改进取消杀进程',
    'macOS：小窗/主预览 HEVC 播失败时自动回退为 H.264 兼容预览',
    '一键更新前可保存工作区，重启后自动恢复列表与筛选'
  ],
  '1.0.2': [
    '关于窗口支持检查更新、下载进度与重启安装',
    '顶栏版本按钮与菜单「检查更新」可自动检查并下载；有新版本时显示红点',
    'Esc 可关闭当前弹层或退出编辑态',
    '更新下载进度在顶栏横幅与关于窗口同步显示'
  ],
  '1.0.1': [
    '缩略图单击选择当前项；多选后可在缩略图内同时小窗预览',
    '保存片段可选类别源目录（实际写入「源目录/类别名/」），本次运行内沿用',
    '当前编辑项高亮更明显；导入列表按文件名字母序排列',
    '各大类（含「其他」）均可添加自定义类别标签',
    '自定义源目录导出后重开文件夹仍可回看已分类；Windows 上 HEVC 自动兼容预览',
    '应用单实例运行，避免重复打开导致文件占用'
  ],
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
