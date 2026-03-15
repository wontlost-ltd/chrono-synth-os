/**
 * 跨运行时文案字典 — 冻结的 message ID 与中文文案
 * 所有运行时使用相同 ID，各端通过 ID 渲染对应语言
 * 模板变量使用 ICU MessageFormat 的 {name} 语法
 */

export type CopyMessageId =
  | 'sync.unconfigured'
  | 'sync.disabled'
  | 'sync.idle'
  | 'sync.pulling'
  | 'sync.merging'
  | 'sync.pushing'
  | 'sync.paused'
  | 'sync.offline'
  | 'sync.conflicted'
  | 'sync.error'
  | 'portability.export_started'
  | 'portability.export_completed'
  | 'portability.export_failed'
  | 'portability.export_partial'
  | 'portability.import_dryrun'
  | 'portability.import_completed'
  | 'portability.import_failed'
  | 'portability.import_blocked'
  | 'conflict.empty_state'
  | 'conflict.blocking'
  | 'conflict.warning';

export const zhCNCatalog: Readonly<Record<CopyMessageId, string>> = Object.freeze({
  'sync.unconfigured': '同步未配置',
  'sync.disabled': '同步已关闭',
  'sync.idle': '已同步',
  'sync.pulling': '正在拉取远程更改...',
  'sync.merging': '正在合并更改...',
  'sync.pushing': '正在推送 {count} 项更改...',
  'sync.paused': '同步已暂停',
  'sync.offline': '离线模式，已排队 {count} 项更改',
  'sync.conflicted': '同步已暂停，请先处理 {count} 个冲突',
  'sync.error': '同步出错：{message}',
  'portability.export_started': '导出已开始，完成后会通知你',
  'portability.export_completed': '导出已完成，可以下载',
  'portability.export_failed': '导出失败，请稍后重试',
  'portability.export_partial': '部分数据导出成功，请查看详情',
  'portability.import_dryrun': '导入预检中，请稍候...',
  'portability.import_completed': '导入已完成',
  'portability.import_failed': '导入失败，请查看错误详情',
  'portability.import_blocked': '导入预检发现阻塞问题，请先修复后重试',
  'conflict.empty_state': '没有待处理的冲突',
  'conflict.blocking': '{count} 个阻塞冲突需要处理',
  'conflict.warning': '{count} 个非阻塞冲突，建议处理',
});
