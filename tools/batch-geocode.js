/**
 * 批量地理编码 — 为有地址但缺经纬度的门店自动获取坐标
 * 用法: node tools/batch-geocode.js
 */
const db = require('../lib/db');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const KEY = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).amapWebKey;
if (!KEY) { console.error('❌ 未配置 amapWebKey'); process.exit(1); }

async function geocode(address) {
  const q = `key=${encodeURIComponent(KEY)}&address=${encodeURIComponent(address)}`;
  const resp = await fetch(`https://restapi.amap.com/v3/geocode/geo?${q}`);
  return resp.json();
}

async function main() {
  await db.init();

  const stores = db.queryAll(
    `SELECT id, store_name, province, city, district, address, lat, lng
     FROM stores
     WHERE (lat IS NULL OR lat = 0 OR lat = '') AND (lng IS NULL OR lng = 0 OR lng = '')
       AND address IS NOT NULL AND address != ''
     ORDER BY id`
  );

  if (!stores.length) { console.log('✅ 所有有地址的门店已有经纬度'); db.close(); return; }

  console.log(`🔍 找到 ${stores.length} 家缺经纬度的门店，开始批量获取...\n`);

  let ok = 0, fail = 0;

  for (const s of stores) {
    const parts = [s.province, s.city, s.district, s.address].filter(Boolean);
    const addr = parts.join('');
    try {
      const data = await geocode(addr);
      if (data.status === '1' && data.geocodes?.length > 0) {
        const [lng, lat] = data.geocodes[0].location.split(',');
        db.run('UPDATE stores SET lat=?, lng=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [parseFloat(lat), parseFloat(lng), s.id]);
        console.log(`  ✅ [${s.id}] ${s.store_name} → ${lng}, ${lat}`);
        ok++;
      } else {
        const info = data.info || data.infocode || '无结果';
        console.log(`  ⚠️  [${s.id}] ${s.store_name} → ${info}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ❌ [${s.id}] ${s.store_name} → 网络错误: ${e.message}`);
      fail++;
    }
    // 高德 QPS 限制：每秒最多约 30 次，保守间隔 200ms
    await new Promise(r => setTimeout(r, 200));
  }

  db.save();
  db.close();
  console.log(`\n📊 完成：成功 ${ok}，失败 ${fail}，共 ${stores.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
