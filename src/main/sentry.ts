/**
 * 错误上报入口（原 Sentry，现改为发邮件到管理员邮箱）。
 * 保留文件名与导出名，减少主进程其它文件的改动面。
 */
export {
  initMainSentry,
  captureMainError,
  flushErrorReports,
  ERROR_REPORT_EMAIL
} from './errorMail'
