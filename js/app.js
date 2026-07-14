/**
 * 中控后台 - 主逻辑 v0.2.0
 * 支持后端 API：企业微信数据读取 + Webhook 推送
 */

const API_BASE = ''; // 与静态页面同源，由 express.static 提供

// ===== 全局状态 =====
let currentPage = 'dashboard';
let serverOnline = false;
let currentSub = "";

// ===== 多标签页管理 =====
const PAGE_DEFAULT_SUB = {
  'analysis': 'revenue',
  'store-management': 'info-basic',
  'menu-management': 'overview',
  'cost-accounting': 'daily',
};

const SUB_LABELS = {
  'analysis': { revenue: '门店营收构成', cost: '门店成本分析', sales: '门店销量统计', supplies: '门店耗材消耗' },
  'store-management': { 'info-basic': '门店基本信息', 'info-platform': '第三方平台', 'info-config': '门店配置', fixed: '固定成本', operating: '运营成本' },
  'menu-management': { overview: '菜品总览', cost: '菜品成本', expiry: '效期管理' },
  'cost-accounting': { daily: '日成本核算', weekly: '周成本核算', monthly: '月成本核算' },
};

const TabManager = {
  tabs: [],
  activeId: null,

  // 当前正在渲染的面板 ID（供 getPanelEl 使用）
  _renderingId: null,

  _title(page, sub) {
    const pageDef = pages[page];
    if (!pageDef) return page;
    if (sub && SUB_LABELS[page] && SUB_LABELS[page][sub]) {
      return pageDef.title + ' · ' + SUB_LABELS[page][sub];
    }
    return pageDef.title;
  },

  open(page, sub) {
    const id = sub ? page + '-' + sub : page;
    const existing = this.tabs.find(t => t.id === id);
    if (existing) {
      this._activate(existing);
      return;
    }

    if (!sub && PAGE_DEFAULT_SUB[page]) {
      sub = PAGE_DEFAULT_SUB[page];
      return this.open(page, sub);
    }

    const title = this._title(page, sub);
    const panel = document.createElement('div');
    panel.className = 'tab-content-panel';
    panel.id = 'tab-content-' + id;
    document.getElementById('contentArea').appendChild(panel);

    const tab = {
      id: id, page: page,
      sub: sub || null,
      title: title,
      el: panel,
      rendered: false,
      closable: page !== 'dashboard',
    };

    this.tabs.push(tab);
    this._renderTab(tab);
    this._activate(tab);
    this._renderTabBar();
    setTimeout(() => this._scrollToTab(id), 50);
  },

  _renderTab(tab) {
    if (tab.rendered) return;
    const pageDef = pages[tab.page];
    if (!pageDef) return;
    let html = pageDef.render();
    html = html.replace(/id="analysisContent"/g, 'id="analysisContent-' + tab.id + '"');
    html = html.replace(/id="storeMgmtContent"/g, 'id="storeMgmtContent-' + tab.id + '"');
    html = html.replace(/id="menuContent"/g, 'id="menuContent-' + tab.id + '"');
    html = html.replace(/id="costContent"/g, 'id="costContent-' + tab.id + '"');
    tab.el.innerHTML = html;
    tab.rendered = true;
    this._renderingId = tab.id;
    if (pageDef.onRender) pageDef.onRender();
    this._renderingId = null;
    if (pageBindings[tab.page]) pageBindings[tab.page]();
  },

  switchTo(id) {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) this._activate(tab);
  },

  _activate(tab) {
    if (this.activeId === tab.id) return;
    if (this.activeId) {
      const old = this.tabs.find(t => t.id === this.activeId);
      if (old) old.el.classList.remove('active');
    }
    this.activeId = tab.id;
    tab.el.classList.add('active');
    document.getElementById('contentArea').classList.add('visible');
    document.getElementById('pageTitle').textContent = tab.title;
    currentPage = tab.page;

    // 展开侧边栏子菜单
    const nav = document.getElementById('sidebarNav');
    const parentItem = nav.querySelector('.nav-parent[data-page="' + tab.page + '"]');
    if (parentItem) {
      const sub = parentItem.closest('.nav-group').querySelector('.nav-sub');
      if (sub) {
        nav.querySelectorAll('.nav-sub.open').forEach(s => s.classList.remove('open'));
        nav.querySelectorAll('.nav-parent.expanded').forEach(p => p.classList.remove('expanded'));
        sub.classList.add('open');
        parentItem.classList.add('expanded');
      }
    } else {
      nav.querySelectorAll('.nav-sub.open').forEach(s => s.classList.remove('open'));
      nav.querySelectorAll('.nav-parent.expanded').forEach(p => p.classList.remove('expanded'));
    }

    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === tab.page);
    });
    document.querySelectorAll('.popup-item').forEach(item => {
      item.classList.toggle('active',
        item.dataset.page === tab.page && item.dataset.sub === tab.sub);
    });

    this._renderTabBar();
    this._scrollToTab(tab.id);
  },

  close(id) {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    if (!tab.closable) return;
    tab.el.remove();
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) this._activate(next);
      else { document.getElementById('contentArea').classList.remove('visible'); this.activeId = null; }
    }
    this._renderTabBar();
  },

  closeOthers() {
    const active = this.tabs.find(t => t.id === this.activeId);
    if (!active) return;
    const toClose = this.tabs.filter(t => t.id !== this.activeId && t.closable);
    toClose.forEach(t => t.el.remove());
    this.tabs = this.tabs.filter(t => !toClose.includes(t));
    this._renderTabBar();
  },

  _renderTabBar() {
    const bar = document.getElementById('tabBar');
    if (!bar) return;
    bar.innerHTML = this.tabs.map(t => {
      const isActive = t.id === this.activeId;
      const closeBtn = t.closable
        ? '<span class="tab-close" data-close="' + t.id + '" title="关闭">×</span>'
        : '';
      return '<div class="tab-item' + (isActive ? ' active' : '') + '" data-tab="' + t.id + '" title="' + escapeHtml(t.title) + '">'
        + '<span class="tab-title">' + escapeHtml(t.title) + '</span>' + closeBtn
        + '</div>';
    }).join('');
  },

  _scrollToTab(id) {
    const bar = document.getElementById('tabBar');
    const item = bar ? bar.querySelector('.tab-item[data-tab="' + id + '"]') : null;
    if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  },
};


document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  TabManager.open('dashboard');
  initTabBarEvents();
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
  const nav = document.getElementById('sidebarNav');

  // 弹出菜单：hover 显示，离开隐藏
  nav.querySelectorAll('.nav-group').forEach(group => {
    const popup = group.querySelector('.nav-popup');
    const parent = group.querySelector('.nav-parent');
    if (!popup || !parent) return;

    let hideTimer = null;

    group.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      // 关闭其他弹出菜单
      nav.querySelectorAll('.nav-popup.visible').forEach(p => {
        if (p !== popup) p.classList.remove('visible');
      });
      nav.querySelectorAll('.nav-parent.popup-open').forEach(p => {
        if (p !== parent) p.classList.remove('popup-open');
      });
      // 定位弹出菜单
      const rect = parent.getBoundingClientRect();
      popup.style.top = rect.top + 'px';
      popup.classList.add('visible');
      parent.classList.add('popup-open');
    });

    group.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(() => {
        popup.classList.remove('visible');
        parent.classList.remove('popup-open');
      }, 150);
    });
  });

  // 弹出菜单项点击 → 切换页面
  nav.addEventListener('click', (e) => {
    const popupItem = e.target.closest('.popup-item');
    if (popupItem) {
      const page = popupItem.dataset.page;
      const sub = popupItem.dataset.sub;
      if (page && sub) switchTab(page, sub);
      // 关闭弹出菜单
      popupItem.closest('.nav-popup').classList.remove('visible');
      popupItem.closest('.nav-group').querySelector('.nav-parent').classList.remove('popup-open');
      return;
    }

    const item = e.target.closest('.nav-item');
    if (!item) return;

    // 父菜单项点击 → 打开默认子页面
    if (item.classList.contains('nav-parent')) {
      const page = item.dataset.page;
      if (page) navigateTo(page);
      return;
    }

    // 普通菜单项 → 直接导航
    const page = item.dataset.page;
    if (page) navigateTo(page);
  });
}

function navigateTo(page) {
  TabManager.open(page, null);
}

// ===== 侧边栏折叠 =====
function initMenuToggle() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
}

// ===== 标签栏事件 =====
function initTabBarEvents() {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.tab-close');
    if (closeBtn) { e.stopPropagation(); TabManager.close(closeBtn.dataset.close); return; }
    const item = e.target.closest('.tab-item');
    if (item) TabManager.switchTo(item.dataset.tab);
  });
  const btnClose = document.getElementById('btnCloseAllTabs');
  if (btnClose) {
    btnClose.addEventListener('click', () => TabManager.closeOthers());
  }
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

async function apiPut(path, body) {
  const resp = await fetch(API_BASE + path, {
    method: 'PUT',
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

// 多标签页下获取当前渲染面板内的元素（避免 ID 冲突）
function getPanelEl(baseId) {
  const id = TabManager._renderingId ? baseId + '-' + TabManager._renderingId : baseId;
  return document.getElementById(id);
}

function showEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ===== 页面定义 =====
const pages = {

  // ======== 数据概括(增强版) ========
  dashboard: {
    title: '数据概括',
    async onRender() {
      try {
        const stats = await apiGet('/api/dashboard/stats');
        const s = stats.stats;
        showEl('statStores', s.storeCount);
        showEl('statActive', s.activeStores);
        showEl('statEmployees', s.employeeCount);
        showEl('statMenu', s.menuCount);
        showEl('statPush', s.pushSuccess + '/' + s.pushTotal);
        let apiOk = false, webhookOk = false;
        try { const cfg = await apiGet('/api/config'); apiOk = cfg.configured; webhookOk = cfg.webhookConfigured; } catch {}
        const apiEl = document.getElementById("statApi");
        showEl('statApi', apiOk ? '已配置' : '未配置');
        if (apiEl) apiEl.className = 'stat-value ' + (apiOk ? 'success' : 'warning');
        showEl('statWebhook', webhookOk ? '已配置' : '未配置');
        const whEl = document.getElementById("statWebhook");
        if (whEl) whEl.className = 'stat-value ' + (webhookOk ? 'success' : 'warning');
      } catch {
        showEl('statStores', '—');
      }
    },
    render() {
      return `
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-label">门店总数</div><div class="stat-value primary" id="statStores">—</div></div>
          <div class="stat-card"><div class="stat-label">正常营业</div><div class="stat-value success" id="statActive">—</div></div>
          <div class="stat-card"><div class="stat-label">在职员工</div><div class="stat-value primary" id="statEmployees">—</div></div>
          <div class="stat-card"><div class="stat-label">在售菜品</div><div class="stat-value" id="statMenu">—</div></div>
          <div class="stat-card"><div class="stat-label">API 状态</div><div class="stat-value warning" id="statApi">检测中...</div></div>
          <div class="stat-card"><div class="stat-label">Webhook</div><div class="stat-value warning" id="statWebhook">检测中...</div></div>
          <div class="stat-card"><div class="stat-label">推送成功率</div><div class="stat-value success" id="statPush">—</div></div>
          <div class="stat-card"><div class="stat-label">后端状态</div><div class="stat-value" id="statBackend">${serverOnline ? '在线' : '离线'}</div></div>
        </div>
        <div class="card"><div class="card-header">快速操作</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="navigateTo('api-config')">🔑 中控绑定</button>
            <button class="btn btn-default" onclick="switchTab('store-management','info')">🏪 门店管理</button>
            <button class="btn btn-default" onclick="navigateTo('pipeline')">📤 一键推送</button>
            <button class="btn btn-default" onclick="switchTab('cost-accounting','daily')">💰 成本核算</button>
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
  },

  // ===== 数据分析 =====
  analysis: {
    title: '数据分析',
    render() {
      if (!currentSub) currentSub = 'revenue';
      return `<div id="analysisContent" class="sub-content"><div class="card"><div class="card-header">加载中...</div></div></div>`;
    },
    onRender() {
      if (!currentSub) currentSub = 'revenue';
      updateSubNav('analysis', currentSub);
      analysisBindings[currentSub]?.();
    },
  },

  // ===== AI助手 =====
  'ai-assistant': {
    title: 'AI助手',
    render() {
      return `
        <div class="card"><div class="card-header">🤖 AI问答</div>
        <div class="alert alert-info">输入问题，AI 助手将根据门店经营数据为您提供分析建议。</div>
        <div class="form-group"><label class="form-label">你的问题</label><textarea class="form-input" id="aiQuestion" rows="3" placeholder="例如：哪个门店的利润率最高？" style="resize:vertical;min-height:80px;"></textarea></div>
        <button class="btn btn-primary" id="btnAiAsk">💬 提问</button><div class="test-result" id="aiResult"></div>
        </div>
        <div class="card"><div class="card-header">📷 AI识别门店烤制</div>
        <div class="alert alert-info">此功能将通过摄像头或上传图片，自动识别烤制品的成熟度和品质。开发中，敬请期待。</div>
        <div class="form-group"><label class="form-label">上传图片（开发中）</label><input type="file" class="form-input" accept="image/*" disabled></div>
        <button class="btn btn-default" disabled>🔍 开始识别</button></div>`;
    }
  },

  // ===== 门店管理 =====
  'store-management': {
    title: '门店管理',
    render() {
      if (!currentSub) currentSub = 'info-basic';
      return `<div id="storeMgmtContent" class="sub-content"><div class="card"><div class="card-header">加载中...</div></div></div>`;
    },
    onRender() {
      if (!currentSub) currentSub = 'info-basic';
      updateSubNav('store-management', currentSub);
      storeMgmtBindings[currentSub]?.();
    },
  },

  // ===== 菜品管理 =====
  'menu-management': {
    title: '菜品管理',
    render() {
      if (!currentSub) currentSub = 'overview';
      return `<div id="menuContent" class="sub-content"><div class="card"><div class="card-header">加载中...</div></div></div>`;
    },
    onRender() {
      if (!currentSub) currentSub = 'overview';
      updateSubNav('menu-management', currentSub);
      menuBindings[currentSub]?.();
    },
  },

  // ===== 人员管理 =====
  'user-management': {
    title: '人员管理',
    onRender() { loadUsers(); },
    render() {
      return `
        <div class="card"><div class="card-header">👥 权限设置</div>
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <button class="btn btn-primary" id="btnAddUser">➕ 添加用户</button>
          <button class="btn btn-default" id="btnRefreshUsers">🔄 刷新</button>
        </div>
        <div class="test-result" id="userResult"></div><div id="userTable"></div>
        </div>`;
    }
  },

  // ===== 成本核算 =====
  'cost-accounting': {
    title: '成本核算',
    render() {
      if (!currentSub) currentSub = 'daily';
      return `<div id="costContent" class="sub-content"><div class="card"><div class="card-header">加载中...</div></div></div>`;
    },
    onRender() {
      if (!currentSub) currentSub = 'daily';
      updateSubNav('cost-accounting', currentSub);
      costBindings[currentSub]?.();
    },
  },

  // ===== 数据导入 =====
  'data-import': {
    title: '数据导入',
    onRender() { loadImportStores(); },
    render() {
      return `
        <div class="card"><div class="card-header">📥 日报数据导入</div>
        <div class="alert alert-info">选择 Excel 日报文件，将门店经营数据导入到数据库中。</div>
        <div class="form-group"><label class="form-label">选择日报文件</label><input type="file" class="form-input" id="importFile" accept=".xlsx,.xls"></div>
        <button class="btn btn-primary" id="btnImportDaily">📤 导入日报</button><div class="test-result" id="importResult"></div></div>
        <div class="card"><div class="card-header">📋 耗材数据录入</div>
        <div class="form-group"><label class="form-label">门店</label><select class="form-input" id="supplyStoreId"></select></div>
        <div class="form-group"><label class="form-label">日期</label><input type="date" class="form-input" id="supplyDate"></div>
        <div class="form-group"><label class="form-label">耗材名称</label><input type="text" class="form-input" id="supplyItem" placeholder="如：打包盒、竹签"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div class="form-group"><label class="form-label">数量</label><input type="number" class="form-input" id="supplyQty" value="1" step="0.1"></div>
          <div class="form-group"><label class="form-label">单位</label><input type="text" class="form-input" id="supplyUnit" value="个"></div>
          <div class="form-group"><label class="form-label">单价（元）</label><input type="number" class="form-input" id="supplyPrice" value="0" step="0.01"></div>
        </div>
        <button class="btn btn-primary" id="btnAddSupply">➕ 记录耗材</button><div class="test-result" id="supplyResult"></div></div>`;
    }
  },
};

// ===== 子导航处理 =====
function updateSubNav(page, sub) {
  document.querySelectorAll('.popup-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page && el.dataset.sub === sub);
  });
}
function updateSubTabBar(page, sub) {
  document.querySelectorAll('.sub-tab-bar .sub-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.sub === sub);
  });
}
function fadeContent(el, html) {
  el.innerHTML = html;
  el.classList.remove('sub-content');
  void el.offsetWidth;
  el.classList.add('sub-content');
}
function switchTab(page, sub) {
  currentSub = sub;
  updateSubNav(page, sub);
  updateSubTabBar(page, sub);
  TabManager.open(page, sub);
}

// ===== 页面事件绑定 =====
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


// ===== 分析页面绑定 =====
const analysisBindings = {
  revenue: async () => {
    const el = getPanelEl('analysisContent');
    try {
      const data = await apiGet('/api/analysis/revenue');
      const ch = data.channels;
      const rows = [
        ['店内销售', ch.instore], ['自提销售', ch.pickup], ['美团外卖', ch.mtWaimai],
        ['淘宝闪购', ch.tbFlash], ['京东外卖', ch.jdWaimai], ['美团一键买单', ch.mtPay],
        ['美团团购', ch.mtTuan], ['抖音团购', ch.dyTuan], ['储值消费', ch.stored], ['优惠券', ch.coupon]
      ].filter(r => r[1] > 0).sort((a,b) => b[1]-a[1]);
      const total = rows.reduce((s,r) => s+r[1], 0);
      const tbody = rows.map(r => '<tr><td>'+r[0]+'</td><td>¥'+r[1].toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>'+(total>0?(r[1]/total*100).toFixed(1):0)+'%</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">门店营收构成 <span style="font-weight:400;color:#999;font-size:13px;">合计 ¥'+total.toLocaleString('zh-CN',{minimumFractionDigits:2})+'</span></div>'+
        (rows.length?'<table class="data-table"><thead><tr><th>渠道</th><th>金额</th><th>占比</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无营收数据，请先导入日报</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  cost: async () => {
    const el = getPanelEl('analysisContent');
    try {
      const stores = await apiGet('/api/db/stores');
      const data = await apiGet('/api/analysis/cost');
      const rows = (data.rows||[]).slice(0,20);
      const tbody = rows.map(r => {
        const store = stores.stores?.find(s=>s.id===r.store_id);
        return '<tr><td>'+(store?.store_name||r.store_id||'—')+'</td><td>'+(r.date||'—')+'</td><td>¥'+(r.revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>¥'+(r.food_cost||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td style="color:'+((r.net_profit||0)>=0?'var(--color-success)':'var(--color-danger)')+'">¥'+(r.net_profit||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>';
      }).join('');
      fadeContent(el, '<div class="card"><div class="card-header">门店成本分析</div>'+
        (rows.length?'<table class="data-table"><thead><tr><th>门店</th><th>日期</th><th>营业额</th><th>食材成本</th><th>净利润</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无成本数据</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  sales: async () => {
    const el = getPanelEl('analysisContent');
    try {
      const data = await apiGet('/api/analysis/sales');
      const rows = data.rows||[];
      const tbody = rows.slice(0,30).map(r => '<tr><td>'+(r.store_name||'—')+'</td><td>'+(r.date||'—')+'</td><td>'+(r.order_count||0)+'</td><td>¥'+(r.revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>¥'+(r.actual_revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>¥'+(r.discount_amount||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">门店销量统计</div>'+
        (rows.length?'<table class="data-table"><thead><tr><th>门店</th><th>日期</th><th>订单数</th><th>营业额</th><th>实收</th><th>优惠金额</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无销量数据</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  supplies: async () => {
    const el = getPanelEl('analysisContent');
    try {
      const data = await apiGet('/api/analysis/supplies');
      const rows = data.rows||[];
      const totalCost = rows.reduce((s,r)=>s+(r.total_cost||0),0);
      const tbody = rows.map(r => '<tr><td>'+r.item+'</td><td>'+r.total_qty+' '+r.unit+'</td><td>¥'+(r.total_cost||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>'+(totalCost>0?(r.total_cost/totalCost*100).toFixed(1):0)+'%</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">门店耗材消耗 <span style="font-weight:400;color:#999;font-size:13px;">合计 ¥'+totalCost.toLocaleString('zh-CN',{minimumFractionDigits:2})+'</span></div>'+
        (rows.length?'<table class="data-table"><thead><tr><th>耗材</th><th>用量</th><th>金额</th><th>占比</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无耗材数据</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  }
};

// ===== 门店管理绑定 =====
// ===== 门店基本信息（含统计卡片、搜索、分页表格、编辑） =====
let _storeState = { page: 1, page_size: 10, keyword: '', status: '', store_type: '', legal_person: '' };

async function loadStoreBasic() {
  const el = getPanelEl('storeMgmtContent');
  try {
    const [statsData, listData] = await Promise.all([
      apiGet('/api/db/stores/stats'),
      apiGet('/api/db/stores?page=' + _storeState.page + '&page_size=' + _storeState.page_size
        + (_storeState.keyword ? '&keyword=' + encodeURIComponent(_storeState.keyword) : '')
        + (_storeState.status ? '&status=' + encodeURIComponent(_storeState.status) : '')
        + (_storeState.store_type ? '&store_type=' + encodeURIComponent(_storeState.store_type) : '')
        + (_storeState.legal_person ? '&legal_person=' + encodeURIComponent(_storeState.legal_person) : ''))
    ]);
    renderStoreBasic(el, statsData.stats || {}, listData);
  } catch (e) { fadeContent(el, '<div class="alert alert-error">加载失败: ' + escapeHtml(e.message) + '</div>'); }
}

function renderStoreBasic(el, stats, listData) {
  const stores = listData.stores || [];
  const total = listData.total || 0;
  const pg = listData.page || 1;
  const psize = listData.page_size || 10;

  const statusClass = s => {
    if (s === '正常营业') return 'status-open';
    if (s === '筹建中') return 'status-planning';
    if (s === '迁址') return 'status-moving';
    return 'status-closed';
  };

  const tbody = stores.map(s => '<tr>'
    + '<td>' + escapeHtml(s.store_name) + '</td>'
    + '<td><span class="store-status-tag ' + statusClass(s.status) + '">' + escapeHtml(s.status || '—') + '</span></td>'
    + '<td>' + escapeHtml(s.store_type || '—') + '</td>'
    + '<td>' + escapeHtml(s.legal_person || '—') + '</td>'
    + '<td>' + escapeHtml(s.phone || '—') + '</td>'
    + '<td>' + escapeHtml((s.province || '') + (s.city || '') + (s.district || '') || '—') + '</td>'
    + '<td>' + escapeHtml(s.opening_date || '—') + '</td>'
    + '<td><button class="btn btn-default btn-sm" onclick="openStoreEdit(' + s.id + ')">✏️ 编辑</button></td>'
    + '</tr>').join('');

  const totalPages = Math.ceil(total / psize);
  const pageOpts = [10, 20, 50, 100].map(n =>
    '<option value="' + n + '"' + (n === psize ? ' selected' : '') + '>' + n + ' 条/页</option>'
  ).join('');

  let pagination = '';
  if (totalPages > 1) {
    pagination = '<div class="pagination" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;">';
    for (let i = 1; i <= totalPages; i++) {
      pagination += '<button class="btn ' + (i === pg ? 'btn-primary' : 'btn-default') + ' btn-sm" onclick="changeStorePage(' + i + ')">' + i + '</button>';
    }
    pagination += '</div>';
  }

  const html =
    '<div class="store-stats-grid">'
    + '<div class="store-stat-card"><div class="store-stat-num">' + (stats.open_count || 0) + '</div><div class="store-stat-label">已开业门店</div></div>'
    + '<div class="store-stat-card"><div class="store-stat-num">' + (stats.planning_count || 0) + '</div><div class="store-stat-label">筹建中门店</div></div>'
    + '<div class="store-stat-card"><div class="store-stat-num">' + (stats.closed_count || 0) + '</div><div class="store-stat-label">已闭店门店</div></div>'
    + '<div class="store-stat-card store-stat-card-blue"><div class="store-stat-num">' + (stats.direct_count || 0) + '</div><div class="store-stat-label">直营店</div></div>'
    + '<div class="store-stat-card store-stat-card-blue"><div class="store-stat-num">' + (stats.franchise_count || 0) + '</div><div class="store-stat-label">加盟店</div></div>'
    + '<div class="store-stat-card store-stat-card-blue"><div class="store-stat-num">' + (stats.joint_count || 0) + '</div><div class="store-stat-label">联营店</div></div>'
    + '</div>'

    + '<div class="card"><div class="card-header">🔍 搜索门店</div>'
    + '<div class="store-search-row" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">'
    + '<div class="form-group"><label class="form-label">门店名称</label><input type="text" class="form-input" id="sKeyword" placeholder="输入门店名称" value="' + escapeHtml(_storeState.keyword) + '"></div>'
    + '<div class="form-group"><label class="form-label">门店状态</label><select class="form-input" id="sStatus"><option value="">全部</option><option value="正常营业"' + (_storeState.status === '正常营业' ? ' selected' : '') + '>开业</option><option value="筹建中"' + (_storeState.status === '筹建中' ? ' selected' : '') + '>筹建</option><option value="迁址"' + (_storeState.status === '迁址' ? ' selected' : '') + '>迁址</option><option value="已闭店"' + (_storeState.status === '已闭店' ? ' selected' : '') + '>闭店</option></select></div>'
    + '<div class="form-group"><label class="form-label">门店类型</label><select class="form-input" id="sType"><option value="">全部</option><option value="直营店"' + (_storeState.store_type === '直营店' ? ' selected' : '') + '>直营</option><option value="加盟店"' + (_storeState.store_type === '加盟店' ? ' selected' : '') + '>加盟</option><option value="联营店"' + (_storeState.store_type === '联营店' ? ' selected' : '') + '>联营</option></select></div>'
    + '<div class="form-group"><label class="form-label">法人</label><input type="text" class="form-input" id="sLegalPerson" placeholder="输入法人姓名" value="' + escapeHtml(_storeState.legal_person) + '"></div>'
    + '</div>'
    + '<button class="btn btn-primary" id="btnSearchStores">🔍 查询</button></div>'

    + '<div class="card"><div class="card-header">🏪 门店基本信息（共 ' + total + ' 家）</div>'
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;"><span style="font-size:13px;color:#999;">每页</span><select class="form-input" style="width:auto;" id="sPageSize" onchange="changeStorePageSize()">' + pageOpts + '</select></div>'
    + '<table class="data-table"><thead><tr><th>门店名称</th><th>状态</th><th>店型</th><th>法人</th><th>电话</th><th>所在地区</th><th>开业日期</th><th>操作</th></tr></thead>'
    + '<tbody>' + (tbody || '<tr><td colspan="8" style="text-align:center;color:#999;">暂无数据</td></tr>') + '</tbody></table>'
    + pagination + '</div>';

  fadeContent(el, html);

  document.getElementById('btnSearchStores').onclick = () => {
    _storeState.keyword = document.getElementById('sKeyword')?.value?.trim() || '';
    _storeState.status = document.getElementById('sStatus')?.value || '';
    _storeState.store_type = document.getElementById('sType')?.value || '';
    _storeState.legal_person = document.getElementById('sLegalPerson')?.value?.trim() || '';
    _storeState.page = 1;
    loadStoreBasic();
  };
}

function changeStorePage(p) { _storeState.page = p; loadStoreBasic(); }
function changeStorePageSize() {
  _storeState.page_size = parseInt(document.getElementById('sPageSize')?.value) || 10;
  _storeState.page = 1;
  loadStoreBasic();
}

// ===== 编辑弹窗 =====
async function openStoreEdit(id) {
  try {
    const data = await apiGet('/api/db/stores/' + id);
    const s = data.store || {};
    const fields = [
      ['store_name', '门店名称', 'text', true],
      ['status', '门店状态', 'select', false, ['正常营业','筹建中','迁址','已闭店']],
      ['store_type', '门店类型', 'select', false, ['直营店','加盟店','联营店']],
      ['legal_person', '法人', 'text', false],
      ['payment_type', '收款性质', 'text', false],
      ['province', '省', 'text', false],
      ['city', '市', 'text', false],
      ['district', '区', 'text', false],
      ['address', '详细地址', 'text', false],
      ['phone', '手机号', 'text', false],
      ['business_hours', '营业时间', 'text', false],
      ['opening_date', '开业日期', 'date', false],
    ];
    const formHtml = fields.map(f => {
      const val = escapeHtml(String(s[f[0]] || ''));
      const label = f[1];
      if (f[2] === 'select') {
        const opts = f[4].map(o => '<option value="' + escapeHtml(o) + '"' + (val === o ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('');
        return '<div class="form-group"><label class="form-label">' + label + '</label><select class="form-input" id="edit_' + f[0] + '">' + opts + '</select></div>';
      }
      return '<div class="form-group"><label class="form-label">' + label + '</label><input type="' + (f[2] === 'date' ? 'date' : 'text') + '" class="form-input" id="edit_' + f[0] + '" value="' + val + '"' + (f[3] ? ' required' : '') + '></div>';
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
      '<div class="modal-card" style="max-width:600px;max-height:80vh;overflow-y:auto;">'
      + '<div class="modal-header"><h3>✏️ 编辑门店 — ' + escapeHtml(s.store_name) + '</h3>'
      + '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">✕</button></div>'
      + '<div class="modal-body">' + formHtml + '</div>'
      + '<div class="modal-footer"><button class="btn btn-default" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>'
      + '<button class="btn btn-primary" id="btnSaveStoreEdit" data-id="' + id + '">💾 保存</button></div></div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('btnSaveStoreEdit').onclick = () => saveStoreEdit(id);
  } catch (e) { alert('加载门店信息失败: ' + e.message); }
}

async function saveStoreEdit(id) {
  const fields = ['store_name','status','store_type','legal_person','payment_type','province','city','district','address','phone','business_hours','opening_date'];
  const body = {};
  fields.forEach(f => {
    const el = document.getElementById('edit_' + f);
    if (el && el.value !== undefined) body[f] = el.value;
  });
  if (!body.store_name) { alert('门店名称不能为空'); return; }
  try {
    await apiPut('/api/db/stores/' + id, body);
    document.querySelector('.modal-overlay')?.remove();
    loadStoreBasic();
  } catch (e) { alert('保存失败: ' + e.message); }
}

// ===== 门店管理绑定 =====
const storeMgmtBindings = {
  'info-basic': async () => {
    loadStoreBasic();
  },
  'info-platform': async () => {
    const el = getPanelEl('storeMgmtContent');
    fadeContent(el, '<div class="card"><div class="card-header">🔗 第三方平台</div><div class="alert alert-info">第三方平台对接功能开发中。支持美团、饿了么、抖音等平台的订单和评价数据同步。</div><p style="color:#999;padding:12px;">敬请期待...</p></div>');
  },
  'info-config': async () => {
    const el = getPanelEl('storeMgmtContent');
    fadeContent(el, '<div class="card"><div class="card-header">⚙️ 门店配置</div><div class="alert alert-info">门店配置功能开发中。支持各门店独立配置营业时间、桌位、打印机等信息。</div><p style="color:#999;padding:12px;">敬请期待...</p></div>');
  },
  info: async () => {
    const el = getPanelEl('storeMgmtContent');
    try {
      const data = await apiGet('/api/db/stores');
      const stores = data.stores||[];
      const tbody = stores.map(s => '<tr><td>'+s.store_name+'</td><td>'+(s.status||'—')+'</td><td>'+(s.store_type||'—')+'</td><td>'+(s.city||'—')+'</td><td>'+(s.store_size||'—')+'</td><td>'+(s.table_2person?'双人桌×'+s.table_2person:'—')+'</td><td>'+(s.table_4person?'四人桌×'+s.table_4person:'—')+'</td><td>'+(s.phone||'—')+'</td><td>'+(s.opening_date||'—')+'</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">🏪 门店信息（共 '+stores.length+' 家）</div><table class="data-table"><thead><tr><th>门店名称</th><th>状态</th><th>店型</th><th>城市</th><th>面积</th><th>双人桌</th><th>四人桌</th><th>电话</th><th>开业日期</th></tr></thead><tbody>'+tbody+'</tbody></table></div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  fixed: async () => {
    const el = getPanelEl('storeMgmtContent');
    try {
      const storesData = await apiGet('/api/db/stores');
      const stores = storesData.stores||[];
      let html = '<div class="card"><div class="card-header">📋 门店固定成本</div>';
      for (const s of stores.slice(0,10)) {
        try {
          const costs = await apiGet('/api/stores/'+s.id+'/fixed-costs');
          const rows = (costs.costs||[]).map(c => '<tr><td>'+c.cost_type+'</td><td>¥'+(c.amount||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>'+(c.period||'月度')+'</td></tr>').join('');
          html += '<div style="margin-bottom:16px;"><strong>'+s.store_name+'</strong><table class="data-table"><thead><tr><th>成本类型</th><th>金额</th><th>周期</th></tr></thead><tbody>'+(rows||'<tr><td colspan="3">无数据</td></tr>')+'</tbody></table></div>';
        } catch { html += '<div style="margin-bottom:16px;"><strong>'+s.store_name+'</strong><p style="color:#999;">加载失败</p></div>'; }
      }
      html += '</div>';
      fadeContent(el, html);
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  operating: async () => {
    const el = getPanelEl('storeMgmtContent');
    try {
      const storesData = await apiGet('/api/db/stores');
      const stores = storesData.stores||[];
      fadeContent(el, '<div class="card"><div class="card-header">📋 门店运营成本</div><div class="form-group"><label class="form-label">选择门店</label><select class="form-input" id="opStoreSelect" onchange="loadOperatingCosts()">'+stores.map(s=>'<option value="'+s.id+'">'+s.store_name+'</option>').join('')+'</select></div><div id="opCostTable"><p style="color:#999;">请选择门店查看运营成本</p></div></div>');
      if (stores.length) setTimeout(loadOperatingCosts, 100);
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  }
};

// ===== 菜品管理绑定 =====
const menuBindings = {
  overview: async () => {
    const el = getPanelEl('menuContent');
    try {
      const data = await apiGet('/api/menu');
      const items = data.items||[];
      const tbody = items.map(m => '<tr><td>'+m.name+'</td><td>'+(m.category||'—')+'</td><td>¥'+(m.price||0).toFixed(2)+'</td><td>'+(m.status||'—')+'</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">🍽️ 菜品总览（共 '+items.length+' 道）</div><table class="data-table"><thead><tr><th>菜品名称</th><th>分类</th><th>售价</th><th>状态</th></tr></thead><tbody>'+(tbody||'<tr><td colspan="4">无菜品数据</td></tr>')+'</tbody></table></div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  cost: async () => {
    const el = getPanelEl('menuContent');
    try {
      const data = await apiGet('/api/menu');
      const items = (data.items||[]).filter(m => m.status==='在售');
      const tbody = items.map(m => {
        const profit = (m.price||0)-(m.cost||0);
        const rate = m.price>0?(profit/m.price*100).toFixed(1):'0.0';
        return '<tr><td>'+m.name+'</td><td>¥'+(m.price||0).toFixed(2)+'</td><td>¥'+(m.cost||0).toFixed(2)+'</td><td>¥'+profit.toFixed(2)+'</td><td>'+rate+'%</td></tr>';
      }).join('');
      fadeContent(el, '<div class="card"><div class="card-header">💰 菜品成本分析</div><table class="data-table"><thead><tr><th>菜品</th><th>售价</th><th>成本</th><th>毛利</th><th>毛利率</th></tr></thead><tbody>'+(tbody||'<tr><td colspan="5">无菜品数据</td></tr>')+'</tbody></table></div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  expiry: async () => {
    const el = getPanelEl('menuContent');
    try {
      const data = await apiGet('/api/menu');
      const items = (data.items||[]).filter(m => m.expiry_days);
      const tbody = items.map(m => {
        const days = m.expiry_days;
        const cls = days<=1?'color:var(--color-danger)':days<=2?'color:var(--color-warning)':'';
        return '<tr><td>'+m.name+'</td><td>'+(m.category||'—')+'</td><td style="'+cls+'">'+days+' 天</td><td>'+(m.status||'—')+'</td></tr>';
      }).join('');
      fadeContent(el, '<div class="card"><div class="card-header">⏰ 效期管理</div><table class="data-table"><thead><tr><th>菜品</th><th>分类</th><th>保质期</th><th>状态</th></tr></thead><tbody>'+(tbody||'<tr><td colspan="4">无设置效期的菜品</td></tr>')+'</tbody></table></div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  }
};

// ===== 成本核算绑定 =====
const costBindings = {
  daily: async () => {
    const el = getPanelEl('costContent');
    try {
      const storesData = await apiGet('/api/db/stores');
      const stores = storesData.stores||[];
      let html = '<div class="card"><div class="card-header">💡 日成本核算公式</div><div class="alert alert-info">当日门店营业额 − 优惠 = 当日门店实收 − 固定日均成本支出 − 当日食材成本 − 其他门店支出 = <strong>当日净利润</strong></div></div>';
      html += '<div class="card"><div class="card-header">📊 选择门店并计算</div>';
      html += '<div class="form-group"><label class="form-label">门店</label><select class="form-input" id="costStoreId">'+stores.map(s=>'<option value="'+s.id+'">'+s.store_name+'</option>').join('')+'</select></div>';
      html += '<div class="form-group"><label class="form-label">日期</label><input type="date" class="form-input" id="costDate"></div>';
      html += '<button class="btn btn-primary" id="btnCalcCost">🧮 计算日成本</button><div class="test-result" id="costCalcResult"></div></div>';
      html += '<div class="card"><div class="card-header">📋 最近成本核算</div><div id="costRecentTable"><p style="color:#999;">点击按钮加载</p></div></div>';
      fadeContent(el, html);
      document.getElementById('costDate').value = new Date().toISOString().slice(0,10);
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  weekly: async () => {
    const el = getPanelEl('costContent');
    try {
      const data = await apiGet('/api/cost-accounting/weekly');
      const rows = data.rows||[];
      const tbody = rows.map(r => '<tr><td>'+r.week+'</td><td>¥'+(r.revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>¥'+(r.food_cost||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td style="color:'+((r.net_profit||0)>=0?'var(--color-success)':'var(--color-danger)')+'">¥'+(r.net_profit||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">📊 周成本核算</div>'+(rows.length?'<table class="data-table"><thead><tr><th>周</th><th>营业额</th><th>食材成本</th><th>净利润</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无周成本数据</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  },
  monthly: async () => {
    const el = getPanelEl('costContent');
    try {
      const data = await apiGet('/api/cost-accounting/monthly');
      const rows = data.rows||[];
      const tbody = rows.map(r => '<tr><td>'+r.month+'</td><td>¥'+(r.revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td>¥'+(r.food_cost||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td style="color:'+((r.net_profit||0)>=0?'var(--color-success)':'var(--color-danger)')+'">¥'+(r.net_profit||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>').join('');
      fadeContent(el, '<div class="card"><div class="card-header">📊 月成本核算</div>'+(rows.length?'<table class="data-table"><thead><tr><th>月</th><th>营业额</th><th>食材成本</th><th>净利润</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;padding:20px;">暂无月成本数据</p>')+'</div>');
    } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
  }
};

// ===== 页面事件绑定(新页面) =====
const origBindingKeys = Object.keys(pageBindings);

// 成本核算
pageBindings['cost-accounting'] = () => {
  const btn = document.getElementById('btnCalcCost');
  if (btn) btn.onclick = calcDailyCost;
};

// 人员管理
pageBindings['user-management'] = () => {
  const btnAdd = document.getElementById('btnAddUser');
  const btnRefresh = document.getElementById('btnRefreshUsers');
  if (btnAdd) btnAdd.onclick = addUser;
  if (btnRefresh) btnRefresh.onclick = loadUsers;
};

// 数据导入
pageBindings['data-import'] = () => {
  const btnImport = document.getElementById('btnImportDaily');
  const btnSupply = document.getElementById('btnAddSupply');
  if (btnImport) btnImport.onclick = importDailyExcel;
  if (btnSupply) btnSupply.onclick = addSupply;
};

// AI助手
pageBindings['ai-assistant'] = () => {
  const btn = document.getElementById('btnAiAsk');
  if (btn) btn.onclick = aiAsk;
};

// ===== 业务逻辑 =====

// 加载用户列表
async function loadUsers() {
  const el = document.getElementById('userTable');
  try {
    const data = await apiGet('/api/users');
    const users = data.users||[];
    const tbody = users.map(u => '<tr><td>'+(u.username||'')+'</td><td>'+(u.role||'')+'</td><td>'+(u.display_name||'')+'</td><td>'+(u.created_at||'')+'</td></tr>').join('');
    document.getElementById('userTable').innerHTML = '<table class="data-table"><thead><tr><th>用户名</th><th>角色</th><th>显示名称</th><th>创建时间</th></tr></thead><tbody>'+tbody+'</tbody></table>';
  } catch(e) { document.getElementById('userTable').innerHTML = '<div class="alert alert-error">加载失败: '+e.message+'</div>'; }
}

// 添加用户
async function addUser() {
  const username = prompt('请输入用户名:');
  if (!username) return;
  const password = prompt('请输入密码:');
  if (!password) return;
  const role = prompt('角色(管理员/督导/客服):', '客服');
  const display_name = prompt('显示名称:', username);
  try {
    await apiPost('/api/users', { username, password, role, display_name });
    loadUsers();
  } catch(e) { alert('添加失败: '+e.message); }
}

// 加载运营成本
async function loadOperatingCosts() {
  const storeId = document.getElementById('opStoreSelect')?.value;
  if (!storeId) return;
  const el = document.getElementById('opCostTable');
  try {
    const data = await apiGet('/api/stores/'+storeId+'/operating-costs');
    const rows = data.costs||[];
    const tbody = rows.slice(0,20).map(r => '<tr><td>'+(r.date||'—')+'</td><td>'+(r.item||'—')+'</td><td>¥'+(r.amount||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>').join('');
    fadeContent(el, '<table class="data-table"><thead><tr><th>日期</th><th>事项</th><th>金额</th></tr></thead><tbody>'+(tbody||'<tr><td colspan="3">无数据</td></tr>')+'</tbody></table>');
  } catch(e) { fadeContent(el, '<div class="alert alert-error">加载失败: '+e.message+'</div>'); }
}

// 加载导入页面门店列表
async function loadImportStores() {
  try {
    const data = await apiGet('/api/db/stores');
    const stores = data.stores||[];
    const sel = document.getElementById('supplyStoreId');
    if (sel) sel.innerHTML = stores.map(s => '<option value="'+s.id+'">'+s.store_name+'</option>').join('');
    const dateEl = document.getElementById('supplyDate');
    if (dateEl) dateEl.value = new Date().toISOString().slice(0,10);
  } catch {}
}

// 日成本计算
async function calcDailyCost() {
  const storeId = document.getElementById('costStoreId')?.value;
  const date = document.getElementById('costDate')?.value;
  const el = document.getElementById('costCalcResult');
  if (!storeId) return;
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在计算...';
  try {
    const data = await apiPost('/api/cost-accounting/calculate', { store_id: parseInt(storeId), date });
    el.className = 'test-result visible success';
    const d = data.detail;
    el.textContent = '✅ 计算完成！净利润: ¥'+data.net_profit.toLocaleString('zh-CN',{minimumFractionDigits:2})+'\n营业额 ¥'+(d.revenue||0).toLocaleString()+', 实收 ¥'+(d.actualRevenue||0).toLocaleString()+', 日均固定成本 ¥'+d.dailyFixed+', 食材成本 ¥'+d.foodCost+', 其他 ¥'+d.otherCost;
    // 刷新最近列表
    loadRecentCosts();
  } catch(e) { el.className = 'test-result visible error'; el.textContent = '❌ '+e.message; }
}

async function loadRecentCosts() {
  try {
    const data = await apiGet('/api/cost-accounting?limit=10');
    const rows = data.rows||[];
    const tbody = rows.map(r => '<tr><td>'+r.date+'</td><td>'+(r.store_name||'—')+'</td><td>¥'+(r.revenue||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td><td style="color:'+((r.net_profit||0)>=0?'var(--color-success)':'var(--color-danger)')+'">¥'+(r.net_profit||0).toLocaleString('zh-CN',{minimumFractionDigits:2})+'</td></tr>').join('');
    document.getElementById('costRecentTable').innerHTML = rows.length?'<table class="data-table"><thead><tr><th>日期</th><th>门店</th><th>营业额</th><th>净利润</th></tr></thead><tbody>'+tbody+'</tbody></table>':'<p style="color:#999;">暂无数据</p>';
  } catch {}
}

// 导入日报 Excel
async function importDailyExcel() {
  const file = document.getElementById('importFile')?.files?.[0];
  const el = document.getElementById('importResult');
  if (!file) { el.className = 'test-result visible error'; el.textContent = '❌ 请选择文件'; return; }
  el.className = 'test-result visible loading';
  el.textContent = '⏳ 正在导入...';
  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const b64 = e.target.result.split(',')[1];
        const data = await apiPost('/api/reports/daily/import', { data: b64 });
        el.className = 'test-result visible success';
        el.textContent = '✅ '+data.message;
      } catch(err) { el.className = 'test-result visible error'; el.textContent = '❌ '+err.message; }
    };
    reader.readAsDataURL(file);
  } catch(e) { el.className = 'test-result visible error'; el.textContent = '❌ '+e.message; }
}

// 添加耗材
async function addSupply() {
  const storeId = document.getElementById('supplyStoreId')?.value;
  const date = document.getElementById('supplyDate')?.value;
  const item = document.getElementById('supplyItem')?.value.trim();
  const qty = parseFloat(document.getElementById('supplyQty')?.value)||1;
  const unit = document.getElementById('supplyUnit')?.value.trim()||'个';
  const price = parseFloat(document.getElementById('supplyPrice')?.value)||0;
  const el = document.getElementById('supplyResult');
  if (!item) { el.className = 'test-result visible error'; el.textContent = '❌ 请输入耗材名称'; return; }
  try {
    const storesData = await apiGet('/api/db/stores');
    const store = storesData.stores?.find(s=>s.id===parseInt(storeId));
    await apiPost('/api/supplies', { store_id: parseInt(storeId)||null, store_name: store?.store_name||'', date, item, quantity: qty, unit, unit_price: price });
    el.className = 'test-result visible success';
    el.textContent = '✅ 已记录: '+item+' ×'+qty+unit+' ¥'+(qty*price).toFixed(2);
    document.getElementById('supplyItem').value = '';
  } catch(e) { el.className = 'test-result visible error'; el.textContent = '❌ '+e.message; }
}

// AI 问答(占位)
async function aiAsk() {
  const question = document.getElementById('aiQuestion')?.value.trim();
  const el = document.getElementById('aiResult');
  if (!question) { el.className = 'test-result visible error'; el.textContent = '❌ 请输入问题'; return; }
  el.className = 'test-result visible success';
  el.textContent = '🤖 AI助手正在积极学习中，此功能即将开放。您的问题:「'+question+'」已收到。';
}
