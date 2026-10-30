const fs=require('fs'),path=require('path'),assert=require('assert/strict');const root=path.resolve(__dirname,'../miniprogram/src');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const pages=JSON.parse(read('pages.json')).pages;assert(pages.some(p=>p.path==='pages/legal/index'),'缺少公开协议页');
for(const file of ['pages/login/login.vue','pages/staff/join.vue']){const s=read(file);assert(s.includes('<LegalConsent'),'缺少主动同意入口: '+file);assert(s.includes('requireConsent'),'缺少操作前授权检查: '+file)}
assert(read('pages/mine/index.vue').includes('openLegal()'),'我的缺少持续可见协议入口');assert(read('pages/staff/profiles.vue').includes('requireSensitiveConsent(account.value.id)'),'员工资料缺少敏感信息单独同意');assert(read('common/request.js').includes('!hasConsent()'),'业务请求缺少同意拦截');
const privacy=read('common/privacy.mjs');assert(privacy.includes('wx.requirePrivacyAuthorize({'),'缺少微信隐私授权');assert(!/onNeedPrivacyAuthorization\s*\(/.test(privacy),'自定义弹窗变更须重新核验官方同意按钮机制');
const legal=read('common/legal-content.mjs');for(const text of ['深圳鹅太公餐饮连锁发展有限公司','wenhaod32@gmail.com','身份证','银行卡','健康证','撤回','删除','存储'])assert(legal.includes(text),'协议缺少 '+text);
assert(legal.includes('巡检报告与辅助拆解'),'隐私政策缺少巡检AI处理告知');for(const file of ['pages/inspections/index.vue','pages/inspections/checklist.vue'])assert(read(file).includes('InspectionWorkspace'),'巡检页面未复用带授权拦截的工作区: '+file);const inspections=read('components/InspectionWorkspace.vue');assert(inspections.includes('consent_version:c.version')&&inspections.includes('同意识别'),'巡检AI缺少当前告知版本的主动确认');
assert(legal.includes('实习店长培训与档案分级')&&legal.includes('直属督导')&&legal.includes('工资承担门店'),'培训权限及数据用途未同步告知');
assert(pages.some(p=>p.path==='pages/staff/training'),'缺少培训派发页面');
// 新增以下隐私能力必须更新清单、政策、平台申报与测试，不能静默上线。
const reviewed=new Set(['chooseImage','chooseMedia','chooseMessageFile','scanCode','getSystemInfoSync','requirePrivacyAuthorize','openPrivacyContract']);
const candidates=/\b(?:uni|wx)\.(chooseImage|chooseMedia|chooseMessageFile|scanCode|getSystemInfoSync|getSystemInfo|getDeviceInfo|requirePrivacyAuthorize|openPrivacyContract|getUserProfile|getUserInfo|getPhoneNumber|getLocation|chooseLocation|startLocationUpdate|saveImageToPhotosAlbum|saveVideoToPhotosAlbum|openBluetoothAdapter|startBluetoothDevicesDiscovery|addPhoneContact|addPhoneCalendar|setClipboardData|getClipboardData|getRecorderManager|startRecord)\s*\(/g;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(vue|js|mjs)$/.test(p)){for(const m of fs.readFileSync(p,'utf8').matchAll(candidates))assert(reviewed.has(m[1]),'新增隐私能力尚未核验: '+m[1]+' '+p)}}}walk(root);

assert(legal.includes('工资条领取与签收')&&legal.includes('署名')&&legal.includes('本小程序不提供手工请款登记'),'薪资用途及外部请款边界未披露');
for(const page of ['pages/mine/payslips'])assert(pages.some(p=>p.path===page),'个人工作台缺少页面 '+page);
assert(read('pages/mine/payslips.vue').includes('api.consent(c.privacy_version)')&&read('pages/mine/payslips.vue').includes('if(!r.confirm)'),'工资条缺少单独同意与拒绝分支');
console.log('PASS mini privacy: agreement pages, consent gates, sensitive notice, reviewed API inventory. 微信后台指引和真机授权仍须按发布文档人工核验。');

assert(!pages.some(p=>p.path==='pages/mine/requests')&&!read('pages/mine/index.vue').includes('/pages/mine/requests'),'已停用的手工请款入口仍可访问');
assert(pages.some(p=>p.path==='pages/inventory/index'),'缺少门店库存页面');
assert(legal.includes('门店库存、收档与借还')&&legal.includes('员工餐')&&legal.includes('人工耗用'),'库存用途未同步披露');
assert(read('pages/inventory/index.vue').includes('requireConsent()'),'库存操作缺少主动同意检查');
assert(!read('common/api.js').includes('/api/mp/business-ledger/requests'),'小程序仍存在手工请款请求入口');
