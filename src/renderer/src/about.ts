import './about.css'
import appIcon from './assets/app-icon.png'

type UpdateCheckResult = {
  ok: boolean
  updateAvailable: boolean
  version: string
  reason?: string
}

const iconEl = document.getElementById('icon') as HTMLImageElement
const versionEl = document.getElementById('version') as HTMLParagraphElement
const updateBtn = document.getElementById('updateBtn') as HTMLButtonElement
const updateBtnLabel = document.getElementById('updateBtnLabel') as HTMLSpanElement
const updateDot = document.getElementById('updateDot') as HTMLSpanElement
const progressWrap = document.getElementById('progressWrap') as HTMLDivElement
const progressFill = document.getElementById('progressFill') as HTMLDivElement
const progressLabel = document.getElementById('progressLabel') as HTMLSpanElement

iconEl.src = appIcon

let appVersion = ''
let remoteVersion = ''
let updateAvailable = false
let downloaded = false
let downloading = false
let checking = false
let progressPercent = 0

function setDot(on: boolean): void {
  updateDot.hidden = !on
}

function setProgress(percent: number | null): void {
  if (percent == null) {
    progressWrap.hidden = true
    return
  }
  progressPercent = Math.max(0, Math.min(100, percent))
  progressWrap.hidden = false
  progressFill.style.width = `${Math.max(2, Math.round(progressPercent))}%`
  progressLabel.textContent = `${Math.round(progressPercent)}%`
}

function renderButton(): void {
  if (downloaded) {
    updateBtnLabel.textContent = '重启安装'
    updateBtn.disabled = false
    setProgress(null)
    setDot(true)
    return
  }
  if (downloading) {
    const ver = remoteVersion || '?'
    updateBtnLabel.textContent = `更新新版本 ${ver}（${Math.round(progressPercent)}%）`
    updateBtn.disabled = true
    setDot(true)
    return
  }
  if (checking) {
    updateBtnLabel.textContent = '检查中…'
    updateBtn.disabled = true
    return
  }
  if (updateAvailable) {
    updateBtnLabel.textContent = remoteVersion ? `下载更新 ${remoteVersion}` : '下载更新'
    updateBtn.disabled = false
    setDot(true)
    return
  }
  updateBtnLabel.textContent = '检查更新'
  updateBtn.disabled = false
  setDot(false)
}

async function startDownload(): Promise<void> {
  downloading = true
  downloaded = false
  progressPercent = 0
  setProgress(0)
  renderButton()
  try {
    await window.api.downloadUpdate()
  } catch (err) {
    downloading = false
    setProgress(null)
    renderButton()
    const msg = err instanceof Error ? err.message : String(err)
    if (/ZIP file not provided|zip/i.test(msg)) {
      updateBtn.title = '缺少 macOS 自动更新包，请到 GitHub Releases 手动下载'
    } else {
      updateBtn.title = msg || '下载失败'
    }
    versionEl.textContent = appVersion ? `版本 ${appVersion}（下载失败）` : '下载失败'
  }
}

/** 检查更新；有新版本则自动开始下载 */
async function runCheckAndAutoUpdate(): Promise<void> {
  if (downloaded || downloading || checking) return
  checking = true
  renderButton()
  try {
    const r = (await window.api.checkForUpdates()) as UpdateCheckResult
    if (r.reason === 'dev') {
      updateBtnLabel.textContent = '开发模式'
      versionEl.textContent = `版本 ${r.version || appVersion}（开发）`
      return
    }
    if (r.updateAvailable) {
      updateAvailable = true
      remoteVersion = r.version
      checking = false
      await startDownload()
      return
    }
    updateAvailable = false
    remoteVersion = ''
    versionEl.textContent = `版本 ${r.version || appVersion}（已是最新）`
  } catch (err) {
    updateAvailable = false
    updateBtn.title = err instanceof Error ? err.message : '检查失败'
    versionEl.textContent = appVersion ? `版本 ${appVersion}（检查失败）` : '检查失败'
  } finally {
    checking = false
    if (!downloading && !downloaded) renderButton()
  }
}

updateBtn.addEventListener('click', () => {
  void (async () => {
    if (downloaded) {
      try {
        window.api.installUpdate()
      } catch (err) {
        updateBtn.title = err instanceof Error ? err.message : '安装失败'
      }
      return
    }
    if (updateAvailable) {
      await startDownload()
      return
    }
    await runCheckAndAutoUpdate()
  })()
})

window.api.onUpdateAvailable((info) => {
  const ver = (info as { version?: string })?.version || ''
  updateAvailable = true
  remoteVersion = ver || remoteVersion
  if (!downloading && !downloaded && !checking) renderButton()
})

window.api.onUpdateDownloadProgress((percent) => {
  downloading = true
  downloaded = false
  setProgress(percent)
  renderButton()
})

window.api.onUpdateDownloaded(() => {
  downloading = false
  downloaded = true
  updateAvailable = true
  setProgress(null)
  renderButton()
  versionEl.textContent = remoteVersion
    ? `版本 ${appVersion} → ${remoteVersion}`
    : `版本 ${appVersion}`
})

window.api.onUpdateError((message) => {
  if (/No published versions on GitHub|404|ENOTFOUND|ETIMEDOUT|net::ERR_/i.test(message || '')) {
    return
  }
  downloading = false
  checking = false
  setProgress(null)
  renderButton()
  updateBtn.title = message || '更新失败'
})

window.api.onAboutAutoUpdate(() => {
  void runCheckAndAutoUpdate()
})

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  window.close()
})

void (async () => {
  try {
    const info = await window.api.getStartupInfo()
    appVersion = info.version || ''
    versionEl.textContent = appVersion ? `版本 ${appVersion}` : '版本未知'
  } catch {
    versionEl.textContent = '版本未知'
  }
  renderButton()
  const params = new URLSearchParams(window.location.search)
  if (params.get('autoUpdate') === '1') {
    await runCheckAndAutoUpdate()
  }
})()
