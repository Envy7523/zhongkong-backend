/**
 * 中控后台 - 主逻辑 v0.2.0
 * 支持后端 API：企业微信数据读取 + Webhook 推送
 */

const API_BASE = ''; // 与静态页面同源，由 express.static 提供

// ===== 全局状态 =====
let currentPage = 'dashboard';
let serverOnline = false;

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  navigateTo('dashboard');
  initMenuToggle();
  checkServerStatus();
});

// ===== 服务器状态检测 =====
async function checkServerStatus() {
  try {
    const resp = await fetch('/api/config');
    if (resp.ok) {
      serverOnline = true;
      setServerStatus('online', '● 服务运行中');
    } else {
      setServerStatus('offline', '● 服务异常');
    }
  } catch {
    serverOnline = false;
    setServerStatus('offline', '● 后端未启动');
  }
}

function setServerStatus(cls, text) {
  const el = document.getElementById('serverStatus');
  if (!el) return;
  el.className = `topbar-status ${cls}`;
  el.textContent = text;
}

// ===== 导航 =====
function initNavigation() {
  document.getElementById('sidebarNav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    const page = item.dataset.page;
    if (page) navigateTo(page);
  });
}

function navigateTo(page) {
  currentPage = page;
  const pageDef = pages[page];
  if (!pageDef) return;

  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  document.getElementById('pageTitle').textContent = pageDef.title;
  const contentArea = document.getElementById('contentArea');
  contentArea.innerHTML = pageDef.render();
  contentArea.classList.add('visible');

  // 页面渲染后绑定事件
  if (pageDef.onRender) pageDef.onRender();
}

// ===== 侧边栏折叠 =====
function initMenuToggle() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
}

// ===== API 工具函数 =====
async function apiGet(path) {
  const resp = await fetch(API_BASE + path);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function apiPost(path, body) {
  const resp = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ===== 页面定义 =====
const pages = {

  // ======== 仪表盘 ========
  dashboard: {
    title: '仪表盘',
    async onRender() {
      let apiOk = false, webhookOk = false;
      try {
        const cfg = await apiGet('/api/config');
        apiOk = cfg.configured;
        webhookOk = cfg.webhookConfigured;
      } catch {}

      showEl('statApi', apiOk ? '已配置' : '未配置');
      const apiEl = document.getElementById('statApi');
      if (apiEl) apiEl.className = `stat-value ${apiOk ? 'success' : 'warning'}`;

      showEl('statWebhook', webhookOk ? '已配置' : '未配置');
      const whEl = document.getElementById('statWebhook');
      if (whEl) whEl.className = `stat-value ${webhookOk ? 'success' : 'warning'}`;
    },
    render() {
      return `
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">企业微信 API</div>
            <div class="stat-value warning" id="statApi">检测中...</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Webhook 连接</div>
            <div class="stat-value warning" id="statWebhook">检测中...</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">活跃服务</div>
            <div class="stat-value primary">1</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">后端状态</div>
            <div class="stat-value" id="statBackend">${serverOnline ? '在线' : '离线'}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">快速操作</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="navigateTo('api-config')">🔑 配置 API</button>
            <button class="btn btn-default" onclick="navigateTo('data-query')">🔍 查询数据</button>
            <button class="btn btn-default" onclick="navigateTo('pipeline')">📤 一键推送</button>
          </div>
        </div>
      `;
    }
  },

  // ======== API 配置 ========
  'api-config': {
    title: 'API 配置',
    async onRender() {
      try {
        const cfg = await apiGet('/api/config');
        document.getElementById('cfgCorpid').value = cfg.corpid || '';
        document.getElementById('cfgSecret_masked').value = cfg.corpsecret_masked || '';
        document.getElementById('cfgWebhook').value = cfg.webhook || '';
        document.getElementById('cfgWebhookName').value = cfg.webhookName || '';
      } catch (e) {
        showEl('cfgStatus', `<div class="alert alert-error">无法加载配置：${escapeHtml(e.message)}<br>请确认后端已启动（npm start）</div>`);
      }
    },
    render() {
      return `
        <div class="card">
          <div class="card-header">🔑 企业微信 API 配置</div>
          <div class="alert alert-info">
            在这里配置企业微信的 <strong>corpid</strong> 和 <strong>corpsecret</strong>，后端才能调用企业微信 API 读取数据。
            这些凭据<strong>只存在后端</strong>，不会暴露到浏览器。
          </div>
          <div id="cfgStatus"></div>
          <div class="form-group">
            <label class="form-label">CorpID（企业 ID）</label>
            <input type="text" class="form-input" id="cfgCorpid" placeholder="ww...">
            <div class="form-hint">在企业微信管理后台 → 我的企业 → 企业信息 中获取</div>
          </div>
          <div class="form-group">
            <label class="form-label">CorpSecret（应用密钥）</label>
            <input type="password" class="form-input" id="cfgSecret" placeholder="输入 corpsecret（留空则不修改）">
            <div class="form-hint">已保存的密钥不会回显完整内容。如需修改，填入新值后保存</div>
          </div>
          <hr style="margin:20px 0;border-color:var(--color-border);">
          <div class="form-group">
            <label class="form-label">Webhook 地址</label>
            <input type="text" class="form-input" id="cfgWebhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...">
          </div>
          <div class="form-group">
            <label class="form-label">机器人名称（可选）</label>
            <input type="text" class="form-input" id="cfgWebhookName" placeholder="中控通知机器人">
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" id="btnSaveConfig">💾 保存配置</button>
            <button class="btn btn-default" id="btnTestToken">🔑 测试 API 连接</button>
            <button class="btn btn-default" id="btnTestWebhook">🔗 测试 Webhook</button>
          </div>
          <div class="test-result" id="cfgResult"></div>
        </div>

        <div class="card">
          <div class="card-header">📖 说明</div>
          <div style="color:var(--color-text-secondary);line-height:2;">
            <p><strong>CorpID</strong> 和 <strong>CorpSecret</strong> 获取方式：</p>
            <ol style="padding-left:20px;">
              <li>登录 <a href="https://work.weixin.qq.com/" target="_blank">企业微信管理后台</a></li>
              <li>进入「应用管理」→ 选择一个自建应用</li>
              <li>在应用详情中可以看到 CorpID、AgentId 和 Secret</li>
            </ol>
            <p style="margin-top:12px;">
              ⚠️ 注意：不同的 API 可能需要不同的 Secret 类型（通讯录、客户联系等），请确保 Secret 有对应权限。
            </p>
          </div>
        </div>
      `;
    }
  },

  // ======== 数据查询 ========
  'data-query': {
    title: '数据查询',
    render() {
      return `
        <div class="card">
          <div class="card-header">🔍 查询企业数据</div>
          <div class="alert alert-info">
            通过企业微信 API 读取企业内部数据。使用前请先在「API 配置」中填写正确的 corpid 和 corpsecret。
          </div>
          <div class="form-group">
            <label class="form-label">查询类型</label>
            <select class="form-input" id="queryApi">
              <option value="department_list">部门列表</option>
              <option value="user_list">成员列表</option>
              <option value="user_info">成员详情</option>
              <option value="custom">自定义 API</option>
            </select>
          </div>
          <div class="form-group" id="queryParamsGroup">
            <label class="form-label">参数（可选）</label>
            <div id="queryParamsFields">
              <input type="text" class="form-input" id="queryParam1" placeholder="例如：department_id=1 或 userid=xxx" disabled>
            </div>
            <div class="form-hint">根据查询类型填写对应参数</div>
          </div>
          <button class="btn btn-primary" id="btnQuery">🔍 执行查询</button>
          <div class="test-result" id="queryResult"></div>
        </div>

        <div class="card">
          <div class="card-header">可用的企业微信 API</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="text-align:left;border-bottom:2px solid var(--color-border);">
              <th style="padding:8px;">API</th><th style="padding:8px;">说明</th><th style="padding:8px;">所需权限</th>
            </tr></thead>
            <tbody>
              <tr style="border-bottom:1px solid var(--color-border);">
                <td style="padding:8px;">department_list</td>
                <td style="padding:8px;">获取全量部门列表</td>
                <td style="padding:8px;">通讯录读取</td>
              </tr>
              <tr style="border-bottom:1px solid var(--color-border);">
                <td style="padding:8px;">user_list</td>
                <td style="padding:8px;">获取部门成员</td>
                <td style="padding:8px;">通讯录读取</td>
              </tr>
              <tr style="border-bottom:1px solid var(--color-border);">
                <td style="padding:8px;">user_info</td>
                <td style="padding:8px;">获取单个成员详情</td>
                <td style="padding:8px;">通讯录读取</td>
              </tr>
              <tr>
                <td style="padding:8px;">custom</td>
                <td style="padding:8px;">自定义 API 路径（高级）</td>
                <td style="padding:8px;">取决于具体 API</td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }
  },

  // ======== 表格读取 ========
  'table-reader': {
    title: '表格读取',
    render() {
      return `
        <div class="card">
          <div class="card-header">📋 读取企业微信智能表格</div>
          <div class="alert alert-info">
            输入企业微信文档的 <strong>doc_id</strong>（从文档 URL 中获取），读取表格数据。
            支持：智能表格 (smartsheet)。<br>
            使用前请确保 corpsecret 对应应用已开启「文档」权限。
          </div>
          <div class="form-group">
            <label class="form-label">文档 URL 或 Doc ID</label>
            <input type="text" class="form-input" id="tableDocId"
              placeholder="输入文档 URL（自动提取 ID）或直接填 doc_id，如 s3_xxxxx">
            <div class="form-hint">
              从企业微信文档中复制链接，如 <code>https://doc.weixin.qq.com/smartsheet/s3_xxxxx?tab=...</code>
            </div>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
            <button class="btn btn-primary" id="btnTableInfo">📄 获取文档信息</button>
            <button class="btn btn-default" id="btnTableSheets">📑 获取工作表列表</button>
          </div>
          <div class="test-result" id="tableInfoResult"></div>
        </div>

        <div class="card" id="tableRecordsCard" style="display:none;">
          <div class="card-header">📊 读取表格记录</div>
          <div class="form-group">
            <label class="form-label">工作表 ID (sheet_id)</label>
            <input type="text" class="form-input" id="tableSheetId" placeholder="从上一步结果中复制 sheet_id">
          </div>
          <div class="form-group">
            <label class="form-label">返回条数</label>
            <input type="number" class="form-input" id="tableLimit" value="50" min="1" max="500">
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" id="btnTableRecords">📖 读取记录</button>
            <button class="btn btn-default" id="btnTablePipeline">📤 读取并推送到群</button>
          </div>
          <div class="test-result" id="tableRecordsResult"></div>
        </div>
      `;
    }
  },

  // ======== 一键推送 ========
  pipeline: {
    title: '一键推送',
    render() {
      return `
        <div class="card">
          <div class="card-header">📤 读取数据 → 推送到群</div>
          <div class="alert alert-info">
            选择数据源，系统会自动读取数据并通过 Webhook 推送到企业微信群聊。
            使用前请确保「API 配置」中的 corpid、corpsecret 和 Webhook 均已正确填写。
          </div>

          <div class="form-group">
            <label class="form-label">数据源</label>
            <select class="form-input" id="pipelineApi">
              <option value="department_list">📋 部门列表</option>
              <option value="user_list">👥 成员列表</option>
            </select>
          </div>

          <div class="form-group" id="pipelineParamsGroup" style="display:none;">
            <label class="form-label">部门 ID（user_list 需要）</label>
            <input type="text" class="form-input" id="pipelineDeptId" placeholder="1" value="1">
          </div>

          <div class="form-group">
            <label class="form-label">消息格式</label>
            <select class="form-input" id="pipelineFormat">
              <option value="markdown">Markdown（推荐）</option>
              <option value="text">纯文本</option>
            </select>
          </div>

          <button class="btn btn-primary" id="btnPipeline">🚀 读取并推送到群</button>
          <div class="test-result" id="pipelineResult"></div>
        </div>

        <div class="card">
          <div class="card-header">⚡ 快捷操作</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-default" id="btnQuickDepts">📋 推送部门列表</button>
            <button class="btn btn-default" id="btnQuickUsers">👥 推送成员列表</button>
            <button class="btn btn-default" id="btnSendTest">🧪 发送测试消息</button>
          </div>
        </div>

        <div class="card">
          <div class="card-header">✏️ 自定义消息</div>
          <div class="form-group">
            <label class="form-label">消息类型</label>
            <select class="form-input" id="customMsgtype">
              <option value="text">纯文本（无需链接）</option>
              <option value="markdown">Markdown（无需链接）</option>
              <option value="news">图文消息（需跳转链接）</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">标题（可选，仅图文）</label>
            <input type="text" class="form-input" id="customTitle" placeholder="图文消息标题，留空则用正文第一行">
          </div>
          <div class="form-group">
            <label class="form-label">文案内容</label>
            <textarea class="form-input" id="customContent" rows="4" placeholder="输入要发送的文字内容..." style="resize:vertical;min-height:80px;"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">跳转链接 <span style="color:var(--color-danger)" id="customUrlRequired">（图文必填）</span></label>
            <input type="text" class="form-input" id="customUrl" placeholder="https://example.com/article">
            <div class="form-hint">仅图文消息需要。纯文本 / Markdown 可留空</div>
          </div>
          <div class="form-group">
            <label class="form-label">图片链接（可选）</label>
            <input type="text" class="form-input" id="customPicurl" placeholder="https://example.com/image.png">
            <div class="form-hint">填入可公开访问的图片 URL，消息会附带封面图</div>
          </div>
          <button class="btn btn-primary" id="btnSendCustom">📨 发送自定义消息</button>
          <div class="test-result" id="customMsgResult"></div>
        </div>
      `;
    }
  },

  // ======== 日报推送 ========
  report: {
    title: '日报推送',
    render() {
      const today = new Date().toLocaleDateString('zh-CN');
      return `
        <div class="card">
          <div class="card-header">📊 图表配置</div>
          <div class="form-group">
            <label class="form-label">图表标题</label>
            <input type="text" class="form-input" id="reportTitle" placeholder="每日工作汇报" value="每日工作汇报">
          </div>
          <div class="form-group">
            <label class="form-label">副标题（日期等）</label>
            <input type="text" class="form-input" id="reportSubtitle" placeholder="${today}" value="${today}">
          </div>
          <div class="form-group">
            <label class="form-label">图表类型</label>
            <select class="form-input" id="reportChartType">
              <option value="bar">📊 柱状图（对比）</option>
              <option value="line">📈 折线图（趋势）</option>
              <option value="pie">🥧 饼图/环形图（占比）</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">X轴标签（逗号分隔，饼图为名称）</label>
            <input type="text" class="form-input" id="reportLabels" placeholder="研发部,市场部,销售部,运营部,人事部" value="研发部,市场部,销售部,运营部,人事部">
          </div>
          <div class="form-group">
            <label class="form-label">数据集（每行一组：<code>名称=数值,数值,...</code>；饼图只需一行数值）</label>
            <textarea class="form-input" id="reportDatasets" rows="4" placeholder="已完成=42,28,35,20,15&#10;进行中=8,12,5,10,3" style="resize:vertical;min-height:80px;">已完成=42,28,35,20,15
进行中=8,12,5,10,3</textarea>
            <div class="form-hint">
              每行格式：<code>名称=值1,值2,值3</code>。柱状图/折线图支持多组；饼图只需一行数值
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">📝 日报文字（Markdown）</div>
          <div class="form-group">
            <label class="form-label">日报内容（支持 Markdown 语法）</label>
            <textarea class="form-input" id="reportText" rows="8" placeholder="## 📋 今日工作总结&#10;&#10;### ✅ 完成事项&#10;- 项目A进度更新至80%&#10;- 完成客户需求评审&#10;&#10;### ⚠️ 风险与问题&#10;- 暂无&#10;&#10;### 📌 明日计划&#10;- 继续推进项目A&#10;- 准备周报材料" style="resize:vertical;min-height:160px;">## 📋 今日工作总结

### ✅ 完成事项
- 项目A进度更新至80%
- 完成客户需求评审

### ⚠️ 风险与问题
- 暂无

### 📌 明日计划
- 继续推进项目A
- 准备周报材料</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">推送选项</label>
            <div style="display:flex;gap:16px;align-items:center;padding:8px 0;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="reportSendChart" checked> 发送图表
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="reportSendText" checked> 发送文字日报
              </label>
            </div>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" id="btnSendReport">🚀 推送到群</button>
            <button class="btn btn-default" id="btnFillDemo">📋 填充示例数据</button>
          </div>
          <div class="test-result" id="reportResult"></div>
        </div>
      `;
    }
  },

  // ======== 系统设置 ========
  settings: {
    title: '系统设置',
    render() {
      return `
        <div class="card">
          <div class="card-header">⚡ 系统设置</div>
          <p style="color:var(--color-text-secondary);">
            更多设置项将在后续版本中添加。
          </p>
        </div>
        <div class="card">
          <div class="card-header">关于</div>
          <div style="color:var(--color-text-secondary);line-height:1.8;">
            <p><strong>中控后台 v0.2.0</strong></p>
            <p>前后端分离架构：HTML/CSS/JS 前端 + Node.js Express 后端</p>
            <p style="margin-top:8px;">启动方式：<code>npm install && npm start</code>，然后访问 <code>http://localhost:3456</code></p>
          </div>
        </div>
      `;
    }
  }
};

// ===== 页面事件绑定 =====

// 通用：页面渲染后查找按钮并绑定（避免重复绑定）
const pageBindings = {

  'api-config': () => {
    const btnSave = document.getElementById('btnSaveConfig');
    const btnToken = document.getElementById('btnTestToken');
    const btnWebhook = document.getElementById('btnTestWebhook');

    if (btnSave) btnSave.onclick = saveApiConfig;
    if (btnToken) btnToken.onclick = testApiToken;
    if (btnWebhook) btnWebhook.onclick = testWebhookSend;
  },

  'data-query': () => {
    const select = document.getElementById('queryApi');
    const btn = document.getElementById('btnQuery');

    if (select) {
      select.onchange = () => {
        const val = select.value;
        const params = document.getElementById('queryParamsFields');
        const group = document.getElementById('queryParamsGroup');
        if (val === 'department_list') {
          group.style.display = 'none';
        } else if (val === 'user_list') {
          group.style.display = 'block';
          params.innerHTML = '<input type="text" class="form-input" id="queryParam1" placeholder="department_id（默认 1）">';
        } else if (val === 'user_info') {
          group.style.display = 'block';
          params.innerHTML = '<input type="text" class="form-input" id="queryParam1" placeholder="userid（必填）">';
        } else if (val === 'custom') {
          group.style.display = 'block';
          params.innerHTML = `
            <input type="text" class="form-input" id="queryParamPath" placeholder="API 路径，如 /cgi-bin/department/list" style="margin-bottom:6px;">
            <input type="text" class="form-input" id="queryParamExtra" placeholder="额外参数（可选）如 &id=1">
          `;
        }
      };
    }
    if (btn) btn.onclick = doQuery;
  },

  'table-reader': () => {
    const btnInfo = document.getElementById('btnTableInfo');
    const btnSheets = document.getElementById('btnTableSheets');
    const btnRecords = document.getElementById('btnTableRecords');
    const btnPipe = document.getElementById('btnTablePipeline');

    if (btnInfo) btnInfo.onclick = getDocInfo;
    if (btnSheets) btnSheets.onclick = getSheets;
    if (btnRecords) btnRecords.onclick = getRecords;
    if (btnPipe) btnPipe.onclick = tablePipeline;
  },

  pipeline: () => {
    const btnPipe = document.getElementById('btnPipeline');
    const btnDepts = document.getElementById('btnQuickDepts');
    const btnUsers = document.getElementById('btnQuickUsers');
    const btnTest = document.getElementById('btnSendTest');
    const select = document.getElementById('pipelineApi');

    if (select) {
      select.onchange = () => {
        document.getElementById('pipelineParamsGroup').style.display =
          select.value === 'user_list' ? 'block' : 'none';
      };
    }
    if (btnPipe) btnPipe.onclick = doPipeline;
    if (btnDepts) btnDepts.onclick = () => doQuickPipeline('department_list');
    if (btnUsers) btnUsers.onclick = () => doQuickPipeline('user_list');
    if (btnTest) btnTest.onclick = testWebhookSend;

    const btnCustom = document.getElementById('btnSendCustom');
    if (btnCustom) btnCustom.onclick = sendCustomMessage;

    // 消息类型切换：图文时显示链接必填，其他类型隐藏必填提示
    const msgtypeSelect = document.getElementById('customMsgtype');
    if (msgtypeSelect) {
      msgtypeSelect.onchange = () => {
        const isNews = msgtypeSelect.value === 'news';
        const urlInput = document.getElementById('customUrl');
        const urlReq = document.getElementById('customUrlRequired');
        if (urlInput) {
          urlInput.style.opacity = isNews ? '1' : '0.5';
          urlInput.required = isNews;
        }
        if (urlReq) {
          urlReq.textContent = isNews ? '（图文必填）' : '（可选）';
        }
        const titleInput = document.getElementById('customTitle');
        if (titleInput) {
          titleInput.placeholder = isNews ? '图文消息标题，留空则用正文第一行' : '（仅图文消息使用，可忽略）';
        }
      };
      // 初始触发一次
      msgtypeSelect.dispatchEvent(new Event('change'));
    }
  },

  report: () => {
    const btnSend = document.getElementById('btnSendReport');
    const btnDemo = document.getElementById('btnFillDemo');
    if (btnSend) btnSend.onclick = sendReport;
    if (btnDemo) btnDemo.onclick = fillDemoReport;
  }
};

// 在 navigateTo 中，渲染完成后调用对应绑定
const origNavigateTo = navigateTo;
navigateTo = function(page) {
  origNavigateTo(page);
  // 延迟绑定，确保 DOM 已渲染
  setTimeout(() => {
    if (pageBindings[page]) pageBindings[page]();
  }, 50);
};

// ===== 业务逻辑 =====

// 保存 API 配置
async function saveApiConfig() {
  const corpid = document.getElementById('cfgCorpid').value.trim();
  const secret = document.getElementById('cfgSecret').value.trim();
  const webhook = document.getElementById('cfgWebhook').value.trim();
  const webhookName = document.getElementById('cfgWebhookName').value.trim();

  if (!corpid) return showCfgResult('error', '⚠️ 请输入 CorpID');

  const body = { corpid, webhook, webhookName };
  if (secret) body.corpsecret = secret; // 只有填了新值才发送

  try {
    const data = await apiPost('/api/config', body);
    showCfgResult('success', `✅ 配置已保存\nAPI 状态：${data.configured ? '已配置' : '缺少 corpid/corpsecret'}\nWebhook：${data.webhookConfigured ? '已配置' : '未配置'}`);
  } catch (e) {
    showCfgResult('error', `❌ 保存失败：${e.message}`);
  }
}

function showCfgResult(type, msg) {
  const el = document.getElementById('cfgResult');
  if (!el) return;
  el.className = `test-result visible ${type}`;
  el.textContent = msg;
}

// 测试 API Token
async function testApiToken() {
  showCfgResult('loading', '⏳ 正在获取 access_token...');
  try {
    const data = await apiGet('/api/wechat/token');
    showCfgResult('success',
      `✅ Token 获取成功！\n` +
      `来源：${data.cached ? '缓存' : '新获取'}\n` +
      `有效期：${data.expires_in} 秒\n` +
      `Token：${data.access_token.substring(0, 20)}...`
    );
  } catch (e) {
    showCfgResult('error', `❌ 获取失败：${e.message}`);
  }
}

// 测试 Webhook 发送
async function testWebhookSend() {
  const el = document.getElementById('cfgResult') || document.getElementById('pipelineResult');
  if (el) {
    el.className = 'test-result visible loading';
    el.textContent = '⏳ 正在发送测试消息...';
  }
  try {
    const data = await apiPost('/api/wechat/send', {
      msgtype: 'text',
      content: `✅ 中控后台连接测试成功！\n时间：${new Date().toLocaleString()}\n来源：中控后台 v0.2.0`
    });
    if (el) { el.className = 'test-result visible success'; el.textContent = '✅ 测试消息已发送到群聊！'; }
  } catch (e) {
    if (el) { el.className = 'test-result visible error'; el.textContent = `❌ 发送失败：${e.message}`; }
  }
}

// 数据查询
async function doQuery() {
  const api = document.getElementById('queryApi').value;
  const el = document.getElementById('queryResult');
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在查询...';

  const params = {};
  if (api === 'user_list') {
    params.department_id = parseInt(document.getElementById('queryParam1')?.value) || 1;
  } else if (api === 'user_info') {
    params.userid = document.getElementById('queryParam1')?.value.trim();
  } else if (api === 'custom') {
    params.path = document.getElementById('queryParamPath')?.value.trim();
  }

  try {
    const data = await apiPost('/api/wechat/doc', { api, params });
    el.className = 'test-result visible success';
    el.textContent = `✅ 查询成功 (${api})\n` + JSON.stringify(data.data, null, 2);
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ 查询失败：${e.message}`;
  }
}

// 一键推送
async function doPipeline() {
  const api = document.getElementById('pipelineApi').value;
  const format = document.getElementById('pipelineFormat').value;
  const el = document.getElementById('pipelineResult');
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在读取数据并推送到群...';

  const params = {};
  if (api === 'user_list') {
    params.department_id = parseInt(document.getElementById('pipelineDeptId')?.value) || 1;
  }

  try {
    const data = await apiPost('/api/wechat/pipeline', {
      api,
      params,
      msgtype: format,
    });
    el.className = 'test-result visible success';
    el.textContent = `✅ ${data.message}\n\n返回数据摘要：\n${JSON.stringify(data.data, null, 2).substring(0, 500)}...`;
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ 推送失败：${e.message}`;
  }
}

// 发送自定义消息
async function sendCustomMessage() {
  const msgtype = document.getElementById('customMsgtype').value;
  const title = document.getElementById('customTitle').value.trim();
  const content = document.getElementById('customContent').value.trim();
  const url = document.getElementById('customUrl').value.trim();
  const picurl = document.getElementById('customPicurl').value.trim();
  const el = document.getElementById('customMsgResult');

  if (!content) {
    el.className = 'test-result visible error';
    el.textContent = '❌ 请输入文案内容';
    return;
  }
  // url 仅在图文消息时必填
  if (msgtype === 'news' && !url) {
    el.className = 'test-result visible error';
    el.textContent = '❌ 图文消息必须填写跳转链接';
    return;
  }

  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在发送...';

  try {
    const body = {
      msgtype,
      content,
    };
    if (msgtype === 'news') {
      // 图文消息：用 title/content/url/picurl 构建
      body.title = title || undefined;
      body.url = url;
      body.picurl = picurl || undefined;
    } else if (msgtype === 'markdown') {
      body.content = content;
    }
    // text 类型只需要 content，已在上方设置

    const data = await apiPost('/api/wechat/send', body);
    el.className = 'test-result visible success';
    el.textContent = '✅ ' + data.message;
    // 清空输入
    document.getElementById('customContent').value = '';
    document.getElementById('customTitle').value = '';
    document.getElementById('customUrl').value = '';
    document.getElementById('customPicurl').value = '';
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = '❌ 发送失败：' + e.message;
  }
}

// 快捷推送
async function doQuickPipeline(api) {
  const el = document.getElementById('pipelineResult');
  el.className = 'test-result visible loading';
  el.textContent = `⏳ 正在推送 ${api === 'department_list' ? '部门列表' : '成员列表'}...`;

  try {
    const data = await apiPost('/api/wechat/pipeline', {
      api,
      params: api === 'user_list' ? { department_id: 1 } : {},
      msgtype: 'markdown',
    });
    el.className = 'test-result visible success';
    el.textContent = `✅ ${data.message}`;
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ 推送失败：${e.message}`;
  }
}

// ===== 表格读取 =====

/** 从输入提取 doc_id（兼容纯 ID 或 URL） */
function extractDocId(raw) {
  raw = (raw || '').trim();
  if (/^[se]\w{2,}_/.test(raw)) return raw;
  const m = raw.match(/\/([se]\w{2,}_[\w-]+)/);
  return m ? m[1] : raw;
}

/** 获取文档基础信息 */
async function getDocInfo() {
  const el = document.getElementById('tableInfoResult');
  const docId = extractDocId(document.getElementById('tableDocId').value);
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在获取文档信息...';

  try {
    const data = await apiPost('/api/wechat/table/info', { doc_id: docId });
    el.className = 'test-result visible success';
    el.textContent = JSON.stringify(data.data, null, 2);
    document.getElementById('tableRecordsCard').style.display = 'block';
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ ${e.message}`;
  }
}

/** 获取工作表列表 */
async function getSheets() {
  const el = document.getElementById('tableInfoResult');
  const docId = extractDocId(document.getElementById('tableDocId').value);
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在获取工作表列表...';

  try {
    const data = await apiPost('/api/wechat/table/sheets', { doc_id: docId });
    el.className = 'test-result visible success';
    el.textContent = JSON.stringify(data.data, null, 2);

    const sheets = data.data?.sheet_list || [];
    if (sheets.length > 0) {
      document.getElementById('tableSheetId').value = sheets[0].sheet_id;
    }
    document.getElementById('tableRecordsCard').style.display = 'block';
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ ${e.message}`;
  }
}

/** 读取表格记录 */
async function getRecords() {
  const el = document.getElementById('tableRecordsResult');
  const docId = extractDocId(document.getElementById('tableDocId').value);
  const sheetId = document.getElementById('tableSheetId').value.trim();
  const limit = parseInt(document.getElementById('tableLimit').value) || 50;

  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在读取表格记录...';

  try {
    const data = await apiPost('/api/wechat/table/records', {
      doc_id: docId,
      sheet_id: sheetId,
      limit,
    });
    el.className = 'test-result visible success';
    const records = data.data?.records || [];
    const total = data.data?.total || records.length;
    el.textContent = `✅ 共 ${total} 条记录（返回 ${records.length} 条）\n\n` +
      JSON.stringify(data.data, null, 2);
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ ${e.message}`;
  }
}

/** 读取表格并推送到群 */
async function tablePipeline() {
  const el = document.getElementById('tableRecordsResult');
  const docId = extractDocId(document.getElementById('tableDocId').value);
  const sheetId = document.getElementById('tableSheetId').value.trim();

  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在读取表格并推送到群...';

  try {
    const data = await apiPost('/api/wechat/table/pipeline', {
      doc_id: docId,
      sheet_id: sheetId,
      limit: 50,
    });
    el.className = 'test-result visible success';
    el.textContent = `✅ ${data.message}（共 ${data.recordCount} 条）`;
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ ${e.message}`;
  }
}

// ===== 日报推送 =====

/** 解析数据集文本为 chart_config 所需格式 */
function parseDatasets(raw, isPie) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return isPie ? { labels: [], values: [] } : [];

  if (isPie) {
    // 饼图：每行 "名称=数值"，聚合成 labels + values
    const labels = [];
    const values = [];
    lines.forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) {
        labels.push(line.substring(0, idx).trim());
        values.push(parseFloat(line.substring(idx + 1).trim()) || 0);
      }
    });
    return { labels, values };
  }

  // 柱状图/折线图：每行 "名称=值1,值2,..."
  return lines.map(line => {
    const idx = line.indexOf('=');
    const label = idx > 0 ? line.substring(0, idx).trim() : line;
    const rawVals = idx > 0 ? line.substring(idx + 1) : '0';
    const data = rawVals.split(',').map(v => parseFloat(v.trim()) || 0);
    return { label, data };
  });
}

/** 发送日报 */
async function sendReport() {
  const el = document.getElementById('reportResult');
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在生成日报并推送到群...';

  const title = document.getElementById('reportTitle').value.trim() || '日报';
  const subtitle = document.getElementById('reportSubtitle').value.trim();
  const chartType = document.getElementById('reportChartType').value;
  const labelsRaw = document.getElementById('reportLabels').value.trim();
  const datasetsRaw = document.getElementById('reportDatasets').value.trim();
  const reportText = document.getElementById('reportText').value.trim();
  const sendChart = document.getElementById('reportSendChart').checked;
  const sendText = document.getElementById('reportSendText').checked;

  const isPie = chartType === 'pie';
  const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const datasets = parseDatasets(datasetsRaw, isPie);

  // 构建 chart_config
  let chartConfig = { title, width: 800, height: 420 };
  if (subtitle) chartConfig.subtitle = subtitle;

  if (isPie) {
    chartConfig.labels = datasets.labels || labels;
    chartConfig.values = datasets.values || [];
    chartConfig.size = 460;
  } else {
    chartConfig.labels = labels;
    chartConfig.datasets = datasets;
  }

  // 构建请求体
  const body = {
    title,
    chart_type: sendChart ? chartType : null,
    chart_config: chartConfig,
    report_text: sendText ? reportText : null,
    send_text_only: !sendChart,
  };

  try {
    const data = await apiPost('/api/wechat/report/send', body);
    el.className = 'test-result visible success';
    let summary = `✅ ${data.message}\n`;
    (data.results || []).forEach(r => {
      if (r.type === 'image') summary += `   📷 图表: ${r.ok ? '已发送' + (r.size ? ` (${r.size} 字节)` : '') : '失败'}\n`;
      if (r.type === 'markdown') summary += `   📝 文字: ${r.ok ? '已发送' : '失败'}\n`;
    });
    el.textContent = summary;
  } catch (e) {
    el.className = 'test-result visible error';
    el.textContent = `❌ 推送失败：${e.message}`;
  }
}

/** 填充示例数据 */
function fillDemoReport() {
  const chartType = document.getElementById('reportChartType').value;
  const today = new Date().toLocaleDateString('zh-CN');

  document.getElementById('reportSubtitle').value = today;

  if (chartType === 'pie') {
    document.getElementById('reportTitle').value = '任务状态分布';
    document.getElementById('reportLabels').value = '已完成,进行中,待分配,已取消';
    document.getElementById('reportDatasets').value = '已完成=65\n进行中=20\n待分配=10\n已取消=5';
  } else if (chartType === 'line') {
    document.getElementById('reportTitle').value = '本周活跃用户趋势';
    document.getElementById('reportLabels').value = '周一,周二,周三,周四,周五,周六,周日';
    document.getElementById('reportDatasets').value = '用户数=120,145,132,168,200,178,155\n互动数=45,52,48,61,70,63,55';
  } else {
    document.getElementById('reportTitle').value = '各部门完成任务统计';
    document.getElementById('reportLabels').value = '研发部,市场部,销售部,运营部,人事部';
    document.getElementById('reportDatasets').value = '已完成=42,28,35,20,15\n进行中=8,12,5,10,3';
  }

  document.getElementById('reportText').value = `## 📋 今日工作总结

### ✅ 完成事项
- 项目A进度更新至80%
- 完成客户需求评审

### ⚠️ 风险与问题
- 暂无

### 📌 明日计划
- 继续推进项目A
- 准备周报材料`;

  // 提示
  const el = document.getElementById('reportResult');
  el.className = 'test-result visible success';
  el.textContent = '✅ 已填充「' + document.getElementById('reportTitle').value + '」示例数据';
}
