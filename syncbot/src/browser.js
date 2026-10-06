'use strict';
/**
 * 阶段0：美团专用浏览器（Playwright persistent context + 有界面 Chromium）
 *
 * 职责（本阶段严格限定）：
 *  1. 以「持久化 Profile + 有界面(headed)」方式启动 Chromium，运行在 Xvfb 虚拟显示器中；
 *  2. 登录态、Cookie 全部留在 browser-profiles/<platform>/（0700，独立于中控项目）；
 *  3. 提供 --self-test：验证浏览器可启动、可截图、中文字体可渲染，并立即退出；
 *  4. 正常模式下常驻，等待人工通过 noVNC 登录，收到 SIGTERM 时优雅关闭。
 *
 * 本阶段明确不做：不访问、不猜测美团任何页面/入口/元素/下载动作，不导入、不推送。
 *
 * 用法：
 *   node src/browser.js --platform=meituan            # 常驻（systemd 调用）
 *   node src/browser.js --platform=meituan --self-test # 自检后退出
 *   node src/browser.js --platform=meituan --start-url=https://example.com
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const P = require('./paths');
const config = require('./config');
const { createLogger } = require('./logger');
const lock = require('./lock');
const state = require('./state');
const TC = require('./task-context');

// 常驻服务的 report_type：由 systemd 显式以 --report-type= 传入（未传则显式取报表A）；
// 不使用环境变量或全局状态推断；未授权值直接抛错。
const RESIDENT_REPORT_TYPE = TC.assertResidentReportType((process.argv.find((a) => a.startsWith('--report-type=')) || '').split('=')[1] || 'cashier_composite');
const { sha256, pendingTempFiles } = require('./archive');

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PLATFORM = String(args.platform || 'meituan');
const IS_SELF_TEST = !!args['self-test'];
// 自检使用独立的运行态键：避免自检结束时把「正在运行的正式实例」的运行记录清掉。
// 注意 runtimeFile() 内部会自动加上 "browser-" 前缀，因此这里只给键名本体。
const RUNTIME_KEY = IS_SELF_TEST ? `selftest-${PLATFORM}` : PLATFORM;
const logger = createLogger(`browser-${PLATFORM}`);

function runtimeFile(platform) {
  P.ensureDir(P.runtime);
  return path.join(P.runtime, `browser-${platform}.json`);
}

function readRuntime(platform) {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(platform), 'utf8'));
  } catch (e) {
    return null;
  }
}

function alivePid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function writeRuntime(platform, data) {
  const file = runtimeFile(platform);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function clearRuntime(platform) {
  try {
    fs.unlinkSync(runtimeFile(platform));
  } catch (e) {
    /* 忽略 */
  }
}

function redactDiagnosticText(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(cookie|token|authorization|password)=\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

function errorDiagnostic(error) {
  if (!error || typeof error !== 'object') return { error_name: null, error_code: null, error_message: redactDiagnosticText(error) };
  return {
    error_name: redactDiagnosticText(error.name || null),
    error_code: redactDiagnosticText(error.code || null),
    error_message: redactDiagnosticText(error.message || String(error)),
  };
}

/**
 * 清理上次非正常退出留下的状态，避免 Chromium 启动后弹出
 * 「Restore pages? Chromium didn't shut down correctly」气泡（会遮挡页面、干扰人工操作与后续自动化）。
 * 仅在确认没有活动实例时调用（Preferences 由 Chromium 独占写入，运行中改动会被覆盖/损坏）。
 */
function normalizeProfileExitState(profileDir) {
  const changed = [];
  const prefFile = path.join(profileDir, 'Default', 'Preferences');
  try {
    if (!fs.existsSync(prefFile)) return changed;
    const j = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
    j.profile = j.profile || {};
    let dirty = false;
    if (j.profile.exit_type !== 'Normal') {
      j.profile.exit_type = 'Normal';
      dirty = true;
    }
    if (j.profile.exited_cleanly !== true) {
      j.profile.exited_cleanly = true;
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(prefFile, JSON.stringify(j));
      changed.push('Default/Preferences');
    }
  } catch (e) {
    // Preferences 偶发损坏/解析失败不应阻塞启动，交由 Chromium 自行重建
  }
  return changed;
}

/** 自检页面：验证 headed Chromium + 中文字体 + 截图链路 */
const SELFTEST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>同步机器人 阶段0 自检</title>
<style>
  body{margin:0;padding:28px;background:#0b1020;color:#e8eefc;
       font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",system-ui,sans-serif}
  h1{font-size:26px;margin:0 0 6px}
  .sub{color:#8ea2c8;font-size:14px;margin-bottom:18px}
  .row{font-size:20px;margin:10px 0;line-height:1.5}
  code{background:#1b2440;padding:2px 7px;border-radius:5px;color:#9ad8ff}
  .ok{color:#4ade80}.warn{color:#fbbf24}
  .grid{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  .card{background:#141c33;border:1px solid #24314f;border-radius:10px;padding:12px 14px;min-width:190px}
  .card b{display:block;color:#8ea2c8;font-size:13px;font-weight:400}
  .card span{font-size:19px}
</style></head><body>
  <h1>中控同步机器人 · 阶段0 环境自检</h1>
  <div class="sub">Playwright 持久化 Profile + 有界面 Chromium + Xvfb 虚拟显示器</div>
  <div class="row">中文字体渲染：<b>美团管家 报表 下载 校验 日报 推送 门店 金额 订单</b></div>
  <div class="row">数字符号：2026-09-16 &nbsp;¥1,234,567.89 &nbsp;98.76% &nbsp;↑↓ → ✓ ✗ ⚠</div>
  <div class="row">简体／繁体：外卖运营 · 外送營運 · 闪购 · 閃購</div>
  <div class="grid">
    <div class="card"><b>平台</b><span id="pf">-</span></div>
    <div class="card"><b>DISPLAY</b><span id="dp">-</span></div>
    <div class="card"><b>分辨率</b><span id="rz">-</span></div>
    <div class="card"><b>时区</b><span id="tz">-</span></div>
    <div class="card"><b>语言</b><span id="lg">-</span></div>
    <div class="card"><b>CJK 字体</b><span id="ft">-</span></div>
  </div>
  <div class="row" id="stamp" style="margin-top:18px"></div>
  <script>
    document.getElementById('pf').textContent = '${PLATFORM}';
    document.getElementById('dp').textContent = '-';
    document.getElementById('rz').textContent = window.innerWidth + 'x' + window.innerHeight;
    document.getElementById('tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById('lg').textContent = navigator.language;
    document.getElementById('ft').textContent =
      (document.fonts && document.fonts.check('20px "Noto Sans CJK SC"')) ? 'Noto CJK ✓' : '缺 Noto CJK ✗';
    document.getElementById('stamp').textContent = '渲染时间：' + new Date().toLocaleString('zh-CN', { hour12: false });
  </script>
</body></html>`;

async function main() {
  const browserCfg = config.browser();
  P.ensureDir(P.browserProfiles);
  P.ensureDir(P.downloads);
  P.ensureDir(P.screenshots);
  P.ensureDir(P.logs);
  P.ensureDir(P.state);

  const profileDir = args['profile-dir'] || browserCfg.profileDir || P.profile(PLATFORM);
  // 一致性校验：配置的 downloadDir 必须与 report_type 分层路径一致（双报表隔离）
  const expectedIncoming = P.incoming(PLATFORM, RESIDENT_REPORT_TYPE);
  if (browserCfg.downloadDir && String(browserCfg.downloadDir).trim() && String(browserCfg.downloadDir) !== expectedIncoming) {
    throw new Error(`browser.config.json 的 downloadDir(${browserCfg.downloadDir}) 与 report_type 分层路径(${expectedIncoming}) 不一致：为避免跨报表串写，拒绝启动`);
  }
  const incomingDir = browserCfg.downloadDir || expectedIncoming;
  const startUrl = args['start-url'] || browserCfg.startUrl || 'about:blank';
  const display = process.env.DISPLAY || browserCfg.display || ':99';

  P.ensureDir(profileDir);
  P.ensureDir(incomingDir);

  // 防重复启动：同一平台只允许一个浏览器实例
  const rt = readRuntime(PLATFORM);
  if (rt && alivePid(rt.pid) && !IS_SELF_TEST) {
    logger.error('browser.already_running', { pid: rt.pid, started_at: rt.started_at });
    console.error(`已有 ${PLATFORM} 浏览器实例在运行（pid=${rt.pid}），拒绝重复启动。`);
    process.exit(3);
  }
  // 无活动实例 → 安全地清理上次非正常退出的状态（消除恢复气泡）
  const normalized = normalizeProfileExitState(profileDir);

  logger.step('browser.start', {
    platform: PLATFORM,
    display,
    profile_dir: profileDir,
    download_dir: incomingDir,
    start_url: startUrl,
    self_test: IS_SELF_TEST,
    node: process.version,
    user: os.userInfo().username,
    host: os.hostname(),
    profile_exit_state_normalized: normalized,
    chromium_args: browserCfg.chromiumArgs || [],
  });

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    logger.error('browser.playwright_missing', e);
    console.error('未安装 playwright，请先执行：npm install --save-exact playwright');
    process.exit(4);
  }

  const launchOptions = {
    headless: false, // 有界面：跑在 Xvfb :99 上，可通过 noVNC 人工操作
    viewport: null, // 使用真实窗口尺寸（由 --window-size 决定）
    acceptDownloads: true,
    downloadsPath: incomingDir,
    locale: browserCfg.locale || 'zh-CN',
    timezoneId: browserCfg.timezoneId || 'Asia/Shanghai',
    args: browserCfg.chromiumArgs || [],
    env: { ...process.env, DISPLAY: display },
    handleSIGINT: false,
    handleSIGTERM: false,
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (e) {
    // 最常见原因：同一个 Profile 已被正在运行的实例占用（Chrome 的 Profile 单实例锁）
    const running = readRuntime(PLATFORM);
    const busy = running && alivePid(running.pid);
    logger.error('browser.launch_failed', {
      error: e,
      profile_dir: profileDir,
      profile_busy_by_pid: busy ? running.pid : null,
      hint: busy
        ? 'Profile 已被运行中的浏览器实例占用：先 sudo systemctl stop syncbot-browser.service，或用 --profile-dir 指定临时 Profile'
        : '检查 DISPLAY/Xvfb 是否可用、Chromium 系统依赖是否齐全（xvfb-run 或 journalctl -u syncbot-xvfb）',
    });
    console.error(
      busy
        ? `启动失败：Profile ${profileDir} 被运行中的实例占用（pid=${running.pid}）。请先停止它，或使用 --profile-dir 指定其它 Profile。`
        : `启动失败：${e.message}`
    );
    clearRuntime(RUNTIME_KEY);
    process.exit(5);
  }

  const version = context.browser() ? context.browser().version() : 'unknown';
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30000);

  const rtInfo = {
    platform: PLATFORM,
    pid: process.pid,
    started_at: new Date().toISOString(),
    display,
    profile_dir: profileDir,
    download_dir: incomingDir,
    chromium_version: version,
    self_test: IS_SELF_TEST,
  };
  const rtPath = writeRuntime(RUNTIME_KEY, rtInfo);

  logger.step('browser.ready', {
    chromium_version: version,
    display,
    viewport: page.viewportSize(),
    profile_dir: profileDir,
    runtime_file: rtPath,
  });

  let shuttingDown = false;
  let host = null;
  let contextClosedAt = null;
  const activeDownloads = new Set();

  // 事件：记录页面崩溃/关闭，便于排查。下载处理中关闭上下文会导致 Playwright
  // 丢弃未认领的下载；因此记录时点和处理数量，且在退出前给处理器短暂收口。
  context.on('page', (p) => logger.info('browser.new_page', { url: p.url() }));
  context.on('close', () => {
    contextClosedAt = new Date().toISOString();
    logger.info('browser.context_closed', { shutting_down: shuttingDown, active_download_handlers: activeDownloads.size, closed_at: contextClosedAt });
  });

  /**
   * 被动式下载落盘规范化（阶段1 实测必需，可经 config 关闭）
   *
   * 背景（实测结论）：Playwright 拦截下载后会把文件以随机 GUID 存入 downloadsPath，
   * 真实文件名只存在于 download.suggestedFilename()；且未被 saveAs 认领的下载
   * 会在 context 关闭时被删除 —— 会导致「人工导出的报表既认不出名字、又可能丢失」。
   *
   * 本处理器：不访问任何页面、不含任何选择器、不点击任何按钮、不发起任何下载；
   * 仅在【人工或后续阶段已经触发】下载时，把文件按浏览器给出的原始文件名另存到归档目录。
   */
  const downloadNaming = browserCfg.downloadNaming || 'suggested';
  // 仅允许常见报表文件类型（人工确认要求）；不在白名单的文件仍会保留（绝不丢失人工导出的文件），
  // 但会在审计记录中标记 type_allowed=false 并写警告日志，便于人工处置。
  const allowedExt = (browserCfg.allowedDownloadExtensions || ['xlsx', 'xls', 'csv'])
    .map((e) => String(e).toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  const auditLog = path.join(P.state, `downloads-${PLATFORM}.jsonl`);

  if (downloadNaming === 'suggested') {
    context.on('download', (d) => {
      const work = (async () => {
      const t0 = Date.now();
      const suggestedRaw = (() => {
        try {
          return d.suggestedFilename();
        } catch (_) {
          return null;
        }
      })();
      try {
        const suggested = suggestedRaw || `download-${Date.now()}`;
        // 防路径穿越：只取 basename，剔除路径分隔符/控制字符/前导点
        const safeName =
          path
            .basename(String(suggested))
            .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 180) || `download-${Date.now()}`;
        let target = path.join(incomingDir, safeName);
        // 二次防线：解析后的父目录必须仍是下载目录
        if (path.dirname(path.resolve(target)) !== path.resolve(incomingDir)) {
          throw new Error('目标路径越界，已拒绝保存（疑似路径穿越）');
        }
        // 防同名覆盖：同名则加时间戳另存，绝不覆盖既有文件
        let overwriteAvoided = false;
        if (fs.existsSync(target)) {
          overwriteAvoided = true;
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const ext0 = path.extname(safeName);
          target = path.join(incomingDir, `${path.basename(safeName, ext0)}.${stamp}${ext0}`);
        }
        await d.saveAs(target);
        const st = fs.statSync(target);

        // 清理 Playwright 的 GUID 临时文件（仅限本下载目录内的）
        let guidTempRemoved = null;
        try {
          const guidPath = await d.path();
          if (guidPath && path.dirname(guidPath) === incomingDir && guidPath !== target) {
            fs.unlinkSync(guidPath);
            guidTempRemoved = path.basename(guidPath);
          }
        } catch (_) {
          /* 已被 saveAs 消费，忽略 */
        }

        // .crdownload 等未完成临时文件检测：只检测与记录，绝不删除
        let pending = pendingTempFiles(incomingDir);
        for (let i = 0; i < 12 && pending.length; i++) {
          await new Promise((r) => setTimeout(r, 250));
          pending = pendingTempFiles(incomingDir);
        }

        const ext = path.extname(safeName).toLowerCase().replace(/^\./, '');
        const record = {
          event: 'download_saved',
          at: new Date().toISOString(),
          elapsed_ms: Date.now() - t0,
          platform: PLATFORM,
          // 人工要求必须保留的字段
          suggested_filename: safeName,
          suggested_filename_raw: suggestedRaw === null ? null : String(suggestedRaw),
          archived_filename: path.basename(target),
          archived_path: target,
          archive_dir: incomingDir,
          size: st.size,
          sha256: sha256(target),
          created_at: st.birthtime ? st.birthtime.toISOString() : null,
          mtime: st.mtime.toISOString(),
          // 合规相关
          extension: ext,
          type_allowed: allowedExt.includes(ext),
          allowed_extensions: allowedExt,
          overwrite_avoided: overwriteAvoided,
          guid_temp_removed: guidTempRemoved,
          pending_download_temp_files: pending,
          note: '被动式：仅人工触发下载后落盘；未访问任何页面、未自动点击/导航/导出、未调用项目导入/数据库/企微推送',
        };
        logger.step('browser.download_saved', record);
        try {
          fs.appendFileSync(auditLog, JSON.stringify(record) + '\n');
        } catch (e2) {
          logger.warn('browser.download_audit_append_failed', { audit_log: auditLog, error: e2 });
        }
        if (!record.type_allowed) {
          logger.warn('browser.download_type_not_allowed', {
            extension: ext,
            allowed_extensions: allowedExt,
            archived_path: target,
            note: '文件已保留（绝不丢弃人工导出的文件），仅标记类型不在白名单，请人工确认',
          });
        }
        if (pending.length) {
          logger.warn('browser.download_incomplete_temp_left', {
            pending_download_temp_files: pending,
            note: '检测到未完成下载临时文件，已记录未删除；请人工确认后再使用',
          });
        }
      } catch (e) {
        logger.error('browser.download_save_failed', {
          suggested_filename: suggestedRaw === null ? null : path.basename(String(suggestedRaw)).slice(0, 180),
          context_closed: !!contextClosedAt,
          context_closed_at: contextClosedAt,
          elapsed_ms: Date.now() - t0,
          ...errorDiagnostic(e),
        });
      }
      })();
      activeDownloads.add(work);
      work.finally(() => activeDownloads.delete(work));
    });
    logger.step('browser.download_handler_armed', {
      naming: 'suggested（按浏览器给出的原始文件名落盘）',
      dir: incomingDir,
      allowed_extensions: allowedExt,
      audit_log: auditLog,
      note: '被动式：不访问页面、不点击按钮、不发起下载，仅规范化人工触发的下载文件名并记录审计',
    });
  } else {
    logger.warn('browser.download_handler_disabled', { downloadNaming });
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('browser.shutdown', { signal });
    if (host) {
      try {
        await host.close();
        logger.info('host.closed', { socket: host.socketPath });
      } catch (e) {
        logger.warn('host.close_failed', e);
      }
    }
    try {
      await context.close();
    } catch (e) {
      logger.warn('browser.shutdown_close_failed', e);
    }
    clearRuntime(RUNTIME_KEY);
    await logger.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (IS_SELF_TEST) {
    const result = { ok: false, screenshot: null, page_info: null, errors: [] };
    try {
      await page.goto(startUrl === 'about:blank' ? 'about:blank' : startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
        result.errors.push(`goto: ${e.message}`);
      });
      await page.setContent(SELFTEST_HTML, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      result.page_info = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: navigator.userAgent,
        notoCJK: !!(document.fonts && document.fonts.check('20px "Noto Sans CJK SC"')),
        wzCJK: !!(document.fonts && document.fonts.check('20px "WenQuanYi Zen Hei"')),
        cjkWidth: (() => {
          const el = document.createElement('span');
          el.style.cssText = 'position:absolute;font:32px "Noto Sans CJK SC",sans-serif;white-space:nowrap';
          el.textContent = '美团管家报表下载';
          document.body.appendChild(el);
          const w = el.getBoundingClientRect().width;
          el.remove();
          return Math.round(w);
        })(),
      }));

      const day = new Date().toISOString().slice(0, 10);
      const shotDir = P.screenshotDay(PLATFORM, RESIDENT_REPORT_TYPE, day);
      P.ensureDir(shotDir);
      const shot = path.join(shotDir, `selftest-${PLATFORM}-${Date.now()}.png`);
      await page.screenshot({ path: shot });
      result.screenshot = shot;
      result.ok = fs.existsSync(shot) && fs.statSync(shot).size > 0;
    } catch (e) {
      result.errors.push(e.message);
      logger.error('browser.selftest_failed', e);
    }
    result.ok = result.ok && result.errors.length === 0;
    logger.step('browser.selftest_result', result);
    await context.close();
    clearRuntime(RUNTIME_KEY);
    console.log('SELFTEST_JSON=' + JSON.stringify(result));
    await logger.close();
    process.exit(result.ok ? 0 : 6);
  }

  // 常驻模式：保持进程存活，等待人工登录 / 阶段2 自动化接入
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logger.info('browser.goto', { url: page.url() });
  } catch (e) {
    logger.warn('browser.goto_failed', e);
  }

  // 阶段2：启动 Unix Socket 宿主控制通道（唯一新增监听；权限 0600；不新增任何 TCP 监听）
  try {
    const { startHost } = require('./phase2/host-server');
    host = await startHost({
      context,
      page,
      logger,
      runtimeDir: P.runtime,
      stateDir: P.state,
      platform: PLATFORM,
    });
  } catch (e) {
    logger.error('host.start_failed', e);
    host = null;
  }

  logger.step('browser.waiting_for_human', {
    hint: '浏览器已就绪；可通过 SSH 隧道 + noVNC 人工登录，或经 Unix Socket 宿主执行阶段2 命令',
    host_socket: host ? host.socketPath : null,
    host_ready: !!host,
  });

  await new Promise((resolve) => context.on('close', resolve));
  const pendingAtClose = activeDownloads.size;
  if (pendingAtClose) {
    await Promise.race([
      Promise.allSettled([...activeDownloads]),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  logger.info('browser.exited', { reason: 'context closed (窗口被关闭或 Chromium 退出)', pending_download_handlers_at_close: pendingAtClose, pending_download_handlers_after_grace: activeDownloads.size });
  if (host) {
    try {
      await host.close();
    } catch (_) {}
  }
  clearRuntime(RUNTIME_KEY);
  await logger.close();
  process.exit(0);
}

main().catch(async (e) => {
  logger.error('browser.fatal', e);
  clearRuntime(RUNTIME_KEY);
  try {
    await logger.close();
  } catch (_) {}
  process.exit(1);
});
