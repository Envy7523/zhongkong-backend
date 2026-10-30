'use strict';
// Read only the active Chrome profile's download preferences. Never read cookies,
// login databases or change browser permissions; return fixed diagnostic codes.
const fs=require('node:fs'),path=require('node:path');
function downloadDiagnostics(platform,directory,{base=path.join(process.env.LOCALAPPDATA||'', 'Google','Chrome','User Data'),read=file=>JSON.parse(fs.readFileSync(file,'utf8'))}={}){
 try{const state=read(path.join(base,'Local State')).profile||{},active=Array.isArray(state.last_active_profiles)?state.last_active_profiles:[],known=Object.keys(state.info_cache||{}),profile=state.last_used||(active.length===1?active[0]:known.length===1?known[0]:null);if(!/^(Default|Profile \d+)$/.test(profile||''))return ['download_profile_unknown'];
  const p=read(path.join(base,profile,'Preferences')),codes=['download_prompt_'+(p.download?.prompt_for_download===true?'yes':'no')];
  const normal=v=>String(v||'').replace(/[\\/]+$/,'').replaceAll('/','\\').toLowerCase();
  if(p.download?.default_directory)codes.push('download_directory_'+(normal(p.download.default_directory)===normal(directory)?'same':'different'));
  const setting=n=>n===1?'allow':n===2?'block':'ask';codes.push('download_multiple_default_'+setting(p.profile?.default_content_setting_values?.automatic_downloads));
  const hosts={meituan_delivery:['waimaie.meituan.com','waimaieapp.meituan.com'],jd_delivery:['store.jddj.com','kunce-store.jddj.com'],taobao_flash:['melody.shop.ele.me','melody-stats-next.ele.me','napos-bill-pc.faas.ele.me']}[platform]||[];
  const primary={meituan_delivery:'waimaie.meituan.com',jd_delivery:'store.jddj.com',taobao_flash:'melody.shop.ele.me'}[platform];
  const entries=p.profile?.content_settings?.exceptions?.automatic_downloads||{};for(const host of hosts){const settings=Object.entries(entries).filter(([pattern])=>pattern.split(',').some(part=>{try{return new URL(part.replace('[*.]','')).hostname===host;}catch{return false;}})).map(([,v])=>setting(v.setting));if(settings.length){codes.push('download_multiple_site_'+settings.sort().join('_'));if(host===primary&&settings.includes('allow'))codes.push('download_multiple_top_allow');}}
  return codes;
 }catch{return ['download_preferences_unavailable'];}
}
module.exports={downloadDiagnostics};
