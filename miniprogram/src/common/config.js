/**
 * 小程序端环境配置
 *
 * 【个人测试期】直接写 IP 即可（开发版/体验版在微信开发者工具或手机上打开"调试"后不校验合法域名）：
 *   - 开发者工具模拟器：http://localhost:3456
 *   - 手机真机预览：Windows 局域网 IP，例如 http://192.168.1.8:3456（需放行防火墙 3456 端口）
 *   - 手机用公网：http://134.175.41.247（现有生产服务器，注意不要写生产数据）
 *
 * 【企业阶段】换成 https 备案域名，并把 manifest.json 的 mp-weixin.setting.urlCheck 改为 true。
 *
 * 运行时可在「登录页 → 服务器设置」里临时改地址，无需重新编译。
 */
export const DEFAULT_BASE_URL = 'http://localhost:3456'

export const STORAGE_KEYS = {
  token: 'mp_token',
  user: 'mp_user',
  baseUrl: 'mp_base_url',
}

/** 演示/自测账号提示，正式上线前删掉这个常量与登录页对应区块 */
export const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', label: '管理员（全部门店）' },
  { username: 'agent', password: 'agent123', label: '专员' },
]

/** 事项状态 → 展示样式 */
export const STATUS_STYLE = {
  待开始: { cls: 'mp-chip--pending', color: '#86909c' },
  进行中: { cls: 'mp-chip--doing', color: '#ff7d00' },
  已完成: { cls: 'mp-chip--done', color: '#00b42a' },
  未完成: { cls: 'mp-chip--undone', color: '#f53f3f' },
}

export function statusStyle(status) {
  return STATUS_STYLE[status] || STATUS_STYLE['待开始']
}
