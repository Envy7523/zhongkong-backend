import assert from 'node:assert/strict'
import fs from 'node:fs'
import {hasConsent,acceptConsent,revokeConsent,agreeAndAuthorize,requireSensitiveConsent} from '../miniprogram/src/common/privacy.mjs'
import {LEGAL_VERSION} from '../miniprogram/src/common/legal-content.mjs'
process.env.UNI_PLATFORM='mp-weixin'
const values=new Map();let modalAgrees=false,platformAgrees=false,requests=0,redirects=0
globalThis.uni={getStorageSync:k=>values.get(k),setStorageSync:(k,v)=>values.set(k,v),removeStorageSync:k=>values.delete(k),showToast(){},showModal:o=>o.success({confirm:modalAgrees}),request(){requests++}}
globalThis.wx={requirePrivacyAuthorize:o=>platformAgrees?o.success():o.fail()}
assert.equal(hasConsent(),false)
await assert.rejects(agreeAndAuthorize());assert.equal(hasConsent(),false,'拒绝微信授权不得保存同意')
platformAgrees=true;await agreeAndAuthorize();assert.equal(hasConsent(),true)
assert.equal(values.get('mp_legal_consent').version,LEGAL_VERSION)
assert.equal(await requireSensitiveConsent(42),false);assert.equal(values.has('mp_sensitive_consent'),false)
modalAgrees=true;assert.equal(await requireSensitiveConsent(42),true);modalAgrees=false;assert.equal(await requireSensitiveConsent(42),true)
assert.equal(await requireSensitiveConsent(43),false,'不能沿用另一账号的敏感资料同意')
revokeConsent();assert.equal(hasConsent(),false);assert.equal(values.has('mp_sensitive_consent'),false)
values.set('mp_legal_consent',{version:'old',accepted_at:'old'});assert.equal(hasConsent(),false)
// 执行真实请求函数入口，验证拒绝后不会发出登录、入职或鉴权请求。
const source=fs.readFileSync(new URL('../miniprogram/src/common/request.js',import.meta.url),'utf8')
const body=source.slice(source.indexOf('export function request('),source.indexOf('// ==================== 图片上传')).replace('export function','function')
const request=new Function('hasConsent','toLogin','getToken','uni',body+';return request')(hasConsent,()=>redirects++,()=>'',uni)
for(const url of ['/api/mp/me','/api/mp/auth/password','/api/mp/onboarding/apply','/api/mp/inventory/context','/api/mp/inventory/documents'])await assert.rejects(request({url}),/同意/)
assert.equal(requests,0);assert.equal(redirects,5)
acceptConsent();assert.equal(hasConsent(),true)
console.log('PASS privacy: fresh/old version, platform refusal, sensitive refusal/agreement, withdrawal, no business request before consent')
