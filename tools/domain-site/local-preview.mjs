import { readFileSync } from 'node:fs'

// 生产站点由域名网关注入。开发服务器复用同一脚本，构建时不重复注入。
export function domainFooterPreview() {
  const source = new URL('./icp-footer.js', import.meta.url)
  return {
    name: 'domain-footer-local-preview',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/_site/icp-footer-20261102.js') return next()
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(readFileSync(source))
      })
    },
    transformIndexHtml() {
      return [
        { tag: 'footer', attrs: { id: 'site-icp-filing', style: 'padding:12px 16px;text-align:center;font-size:12px;line-height:20px;background:#f5f7fa;color:#606266' },
          children: '<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">粤ICP备2026169803号</a>', injectTo: 'body' },
        { tag: 'script', attrs: { src: '/_site/icp-footer-20261102.js' }, injectTo: 'body' },
      ]
    },
  }
}
