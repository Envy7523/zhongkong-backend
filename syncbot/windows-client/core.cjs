'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { plainDate } = require('../src/meituan-delivery/operating-file');
const CONFIG_VERSION = 1;
function dataRoot(env = process.env) {
  if (env.ETG_COLLECTOR_HOME) return path.resolve(env.ETG_COLLECTOR_HOME);
  if (!env.LOCALAPPDATA) throw Error('windows_local_appdata_missing');
  return path.join(env.LOCALAPPDATA, 'EtaigongDeliveryCollector');
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  // A validated previous generation survives damaged state or an interrupted write.
  try{const old=fs.readFileSync(file,'utf8'),parsed=JSON.parse(old.replace(/^\uFEFF/,''));if(Array.isArray(value)!==Array.isArray(parsed))throw new SyntaxError('saved_data_shape_invalid');const backup=temporary+'.previous';fs.writeFileSync(backup,old,{mode:0o600});fs.renameSync(backup,file+'.previous');}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
}
function read(file, fallback) {
 const decode=text=>{const value=JSON.parse(text.replace(/^\uFEFF/,''));if(Array.isArray(fallback)&&!Array.isArray(value)||fallback&&typeof fallback==='object'&&!Array.isArray(fallback)&&(!value||typeof value!=='object'||Array.isArray(value)))throw new SyntaxError('saved_data_shape_invalid');return value;};
 try{return decode(fs.readFileSync(file,'utf8'));}catch(error){
  if(error.code==='ENOENT')return fallback;
  const recoverable=new Set(['history.json','pending-uploads.json','cloud-outbox.json','schedule-state.json','remote-task.json','client-instance.json','native-recovery.json','user-paused.json']);
  if(error instanceof SyntaxError&&recoverable.has(path.basename(file))){try{
   const previous=fs.readFileSync(file+'.previous','utf8'),value=decode(previous),copy=file+'.corrupt-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');fs.copyFileSync(file,copy,fs.constants.COPYFILE_EXCL);atomic(file,value);
   atomic(path.join(path.dirname(file),'state-recovery.json'),{at:new Date().toISOString(),file:path.basename(file),server_recheck_required:true});return value;
  }catch{}}
  const failure=Error(error instanceof SyntaxError?'client_saved_data_invalid':'client_saved_data_unavailable');failure.fileName=path.basename(file);failure.cause=error;throw failure;
 }
}
function normalizeConfig(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('client_configuration_invalid');
  const account=String(value.account||'').trim(), chromePath=String(value.chromePath||'').trim();
  const browserMode=value.browserMode||'existing';
  if(!['existing','managed','extension'].includes(browserMode))throw Error('client_browser_mode_invalid');
  if (account && !/^[A-Za-z0-9_-]{1,100}$/.test(account)) throw Error('client_account_invalid');
  let ids=value.storeIds||[];
  if(typeof ids==='string')ids=ids.split(/[\s,，;；]+/).filter(Boolean);
  if(!Array.isArray(ids)||ids.length>200||ids.some(id=>typeof id!=='string'||!/^\d{1,30}$/.test(id)||/^0+$/.test(id)))throw Error('client_store_ids_invalid');
  if(new Set(ids).size!==ids.length)throw Error('client_duplicate_store_ids');
  if(chromePath && (!path.isAbsolute(chromePath)||path.basename(chromePath).toLowerCase()!=='chrome.exe'))throw Error('client_chrome_path_invalid');
  const schedule=value.schedule||{},time=schedule.time||'01:00';
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('client_schedule_time_invalid');
  const enabled=schedule.enabled===true;
  if(enabled&&(!account||!ids.length))throw Error('client_configure_scope_first');
  const downloadDirectory=String(value.downloadDirectory||'').trim();if(downloadDirectory&&!path.isAbsolute(downloadDirectory))throw Error('client_download_directory_invalid');
  return {...(downloadDirectory?{downloadDirectory}:{}),version:CONFIG_VERSION,account,storeIds:[...ids],chromePath,browserMode,schedule:{enabled,time}};
}
function configured(config){if(!config.account||!config.storeIds.length)throw Error('client_configure_scope_first');return config;}
function chinaClock(now=new Date()) { const stamp=new Date(new Date(now).getTime()+28800000).toISOString();return {day:stamp.slice(0,10),time:stamp.slice(11,16),yesterday:new Date(Date.parse(stamp.slice(0,10)+'T00:00:00Z')-86400000).toISOString().slice(0,10)}; }
function validBusinessDate(date,now=new Date()){if(plainDate(date)!==date||date>=chinaClock(now).day)throw Error('client_date_must_be_completed_day');return date;}
function scheduleDue(config,lastAttempt,now=new Date()){const clock=chinaClock(now);return config.schedule.enabled&&clock.time>=config.schedule.time&&lastAttempt!==clock.day?clock:null;}
function discoverChrome(config,env=process.env,exists=fs.existsSync){
  const candidates=[config.chromePath,...[env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root,'Google','Chrome','Application','chrome.exe'))].filter(Boolean);
  const chrome=candidates.find(exists);if(!chrome)throw Error('client_google_chrome_not_found');return chrome;
}
const ERRORS={client_download_directory_missing:'找不到Chrome下载目录。请在客户端设置中填写Chrome实际下载位置后重试。',client_download_directory_invalid:'下载目录需要填写完整绝对路径。',client_configure_scope_first:'先填写账号标识和应采集的美团门店 ID，并保存设置。',client_account_invalid:'账号标识只支持字母、数字、下划线和短横线。',client_store_ids_invalid:'门店 ID 必须逐个填写为完整数字文本，最多 200 个。',client_duplicate_store_ids:'门店 ID 有重复，请核对后保存。',client_chrome_path_invalid:'Chrome 路径必须是本机 chrome.exe 的完整路径。',client_google_chrome_not_found:'没有找到 Google Chrome，请先安装或填写 Chrome 完整路径。',client_schedule_time_invalid:'请填写有效的北京时间，例如 08:00。',client_date_must_be_completed_day:'请选择今天之前的完整营业日。',client_busy:'有操作正在执行，请等待完成。',client_login_required:'请在采集专用 Chrome 中完成登录或验证码，再重新采集。',client_browser_unavailable:'采集专用 Chrome 已关闭或暂不可用，请重新打开。',client_saved_data_invalid:'保存的设置或运行状态无法读取，请保留文件并检查。',client_cloud_not_configured:'此版本只下载和校验，尚未配置云端上传。',operating_human_login_required:'需要人工登录美团，程序没有提交登录信息。',operating_account_mismatch:'页面中的账号标识与配置不一致，请确认品牌后台账号及页面。',operating_report_frame_missing:'未找到经营罗盘报表页面，页面结构可能已变化。',operating_export_pending:'导出尚未就绪；稍后重新采集会恢复原任务，不重复创建。',operating_export_failed:'美团导出任务失败，请在平台检查。',operating_export_job_ambiguous:'发现多个符合条件的导出任务，请人工核对。',operating_browser_failed:'页面操作未完成，请查看运行记录中的失败阶段，检查登录或页面变化。',operating_prior_state_mismatch:'该日期已有另一个账号的任务，不能混用。',operating_archive_hash_changed:'原始下载文件已改变，停止处理以避免误用。',operating_store_coverage_incomplete:'报表门店未覆盖配置范围，请核对门店 ID 和平台数据。'};
Object.assign(ERRORS,{client_existing_chrome_authorization_required:'请在现有Chrome打开 chrome://inspect/#remote-debugging，手动允许本次浏览器的调试连接，再在Chrome提示中确认；程序不会另开登录窗口。',client_existing_platform_tab_missing:'没有找到现有的美团外卖标签页。请在已登录的Chrome打开美团品牌后台，然后重试连接。',client_multiple_platform_tabs:'发现多个美团外卖标签页，无法确定应操作哪一个。请只保留一个目标品牌后台标签页后重试。'});
Object.assign(ERRORS,{client_existing_platform_tab_missing:'没有找到目标外卖平台的标签页。请在原有Chrome打开该平台已登录的品牌后台。',client_multiple_platform_tabs:'目标平台存在多个标签页，无法确定操作对象。请只保留一个该平台品牌后台标签页。',client_platform_invalid:'尚未适配该平台的浏览器连接。'});
Object.assign(ERRORS,{client_local_download_not_found:'未收到本次导出任务的文件；请核对Chrome下载目录、另存为提示及平台是否返回旧文件。',operating_ui_date_mismatch:'平台日期控件没有接受所选日期，已停止导出，避免采集错误营业日。'});
Object.assign(ERRORS,{client_existing_chrome_connection_timeout:'Chrome连接或页面初始化超时；这不等于未授权。请保持美团标签页在前台并检查浏览器提示。',client_existing_chrome_connection_lost:'Chrome调试连接已断开，请检查浏览器是否仍开启调试。',client_existing_chrome_connection_failed:'Chrome连接未建立，请保留诊断记录以便检查连接或页面初始化错误。'});
Object.assign(ERRORS,{client_download_task_mismatch:'平台返回了其他导出任务的文件（可能是旧结果），已停止接收；不能把它认定为本次新数据。'});
Object.assign(ERRORS,{client_report_type_invalid:'不支持此报表类型。',product_unknown_store:'商品表包含范围以外的门店，停止处理。',product_ui_selection_mismatch:'商品字段选择未达到要求，停止导出，请检查页面。',product_header_invalid:'商品文件列与已核验格式不一致，停止处理。',product_row_date_mismatch:'商品明细日期与查询日期不一致。',product_cloud_upload_not_configured:'商品表仅下载校验，尚未配置上传。'});
Object.assign(ERRORS,{settlement_operating_source_required:'请先下载并校验同日营业表，结算导出使用其平台门店ID和店名逐店核对。',settlement_export_pending:'结算报表仍在美团生成中；重新采集会恢复原任务，不会重复提交。',settlement_export_uncertain:'已请求结算导出但尚未确认任务编号，请检查平台导出记录，程序不会重复创建。',settlement_bill_reconciliation_failed:'订单、费用与结算账单金额不一致，请检查原件。',settlement_unknown_store:'结算原件的门店ID与所选门店不一致，停止处理。',settlement_job_missing:'找不到已记录的结算导出任务，请核对平台导出记录。',settlement_export_failed:'美团结算导出失败，请检查平台提示。',settlement_archive_hash_changed:'结算原件已改变，停止处理。'});
Object.assign(ERRORS,{client_browser_not_visible:'Chrome窗口或目标标签页不可见，已停止操作；请保持正常浏览器窗口可见后恢复。',client_platform_access_denied:'美团财务接口返回403，导出控件未就绪；已停止任务，请核对平台会话、访问权限或安全验证。',client_platform_login_expired:'美团会话已失效，请在专用Chrome重新登录后恢复任务。',client_browser_mode_invalid:'请选择现有Chrome测试或专用采集模式。',client_existing_chrome_manual_connection_required:'现有Chrome测试模式尚未手动连接；定时任务不会自动弹出调试授权。独立采集机请配置专用模式。',collector_all_stores_server_upgrade_required:'中控尚未支持全店结算原件，请先升级采集接口；没有退回逐店导出。',client_download_source_conflict:'同名下载文件内容不同，已保留原件并停止处理。',settlement_multiple_parts_requires_review:'平台结算导出包含多个下载部分，尚未核验全部分片，停止处理。'});
Object.assign(ERRORS,{client_extension_not_connected:'采集扩展尚未联通，请确认本地程序、Chrome扩展和目标平台标签页已打开。无需远程调试授权。',client_extension_command_timeout:'扩展未及时返回操作结果；已停止，不自动重放点击或重复创建导出。',extension_reader_not_registered:'页面读取操作不在扩展白名单中，已停止，请更新采集程序与扩展。',extension_element_ambiguous:'页面控件不唯一，已停止，请核对平台页面。',extension_element_timeout:'页面控件未就绪，已停止，请检查平台登录或页面变化。',extension_page_unavailable:'扩展已联通，但目标平台页面脚本未响应，请核对扩展版本和页面脚本状态。',extension_site_permission_denied:'Chrome未允许操作当前平台页面，请在扩展详情核对网站访问权限。',extension_script_execution_failed:'Chrome页面脚本执行失败，已停止，请检查扩展错误记录。',extension_page_changed:'采集期间页面发生切换，已停止；请保持目标平台页面后恢复。',settlement_store_all_option_ambiguous:'结算门店下拉框中的“全部”选项不唯一或未就绪，未提交导出。',settlement_legacy_export_requires_review:'此前导出结果尚未确认，缺少新版本的提交时间证据；已保留状态，不自动重复提交，请先核对平台记录。'});
Object.assign(ERRORS,{platform_export_pending:'平台报表尚未生成，稍后恢复原任务，不重复创建。',platform_download_pending:'下载尚未收到，保留原任务，稍后检查本机下载目录。',platform_frames_ambiguous:'平台报表框架不唯一，已停止，避免操作错误页面。',jd_calendar_month_mismatch:'京东日历月份与营业日不符，未提交导出。',collector_scope_changed:'云端门店范围已变化，已停止旧范围上传，下次执行将重新同步。',collector_source_changed_review_required:'同日已有不同原件，已停止覆盖，请检查来源。'});
function publicError(error){const code=String(error?.message||error).split('\n')[0];return {code:/^[a-z][a-z0-9_:.-]{0,150}$/.test(code)?code:'client_operation_failed',message:ERRORS[code]||(code.startsWith('operating_unknown_store:')?'报表包含未配置的门店 ID，请核对范围。':code.startsWith('operating_')?'报表或下载校验未通过，请保留原件并检查。':'操作未完成，请检查 Chrome 和本地运行日志。')};}
module.exports={dataRoot,atomic,read,normalizeConfig,configured,chinaClock,validBusinessDate,scheduleDue,discoverChrome,publicError};
