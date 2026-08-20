const db = require('../lib/db');

const catalog = [
  ['太公三宝饭','招牌双拼饭','常规','',36,10.27,28.8],
  ['招牌叉鹅饭','招牌双拼饭','份','',31,9.74],
  ['招牌鸡鹅饭','招牌双拼饭','份','',31,10.10],
  ['烧肉拼烧鹅饭','招牌双拼饭','份','',31,11.92],
  ['叉鸡双拼饭','招牌双拼饭','份','',25,7.89],
  ['鸡鸭双拼饭','招牌双拼饭','份','',25,7.19],
  ['葱香叉烧滑蛋饭','港式滑蛋饭','份','',26,8.82],
  ['牛肉滑蛋饭','港式滑蛋饭','份','',28,9.31],
  ['牛叉滑蛋饭','港式滑蛋饭','份','',28,9.06],
  ['招牌烧鹅饭','太公烧味饭','常规','',32,10.60,28.8],
  ['蜜汁叉烧饭','太公烧味饭','份','',28,7.93],
  ['咸香靓鸡饭','太公烧味饭','份','',22,7.29],
  ['金牌烧鸭饭','太公烧味饭','份','',22,6.13],
  ['战斧大鹅翅饭','太公烧味饭','份','切,不切',38,13.93],
  ['澳门烧肉饭','太公烧味饭','份','',28,12.39],
  ['黄金鹅腩饭','太公烧味饭','份','',32,7.79],
  ['蜜汁鸡翅饭','太公烧味饭','份','切,不切',22,8.18],
  ['招牌烧鹅腿饭','至尊腿饭','份','切,不切',45,13.93],
  ['金牌烧鸭腿饭','至尊腿饭','份','切,不切',28,6.66],
  ['咸香靓鸡腿饭','至尊腿饭','份','切,不切',28,6.89],
  ['招牌烧鹅濑粉','烧鹅濑粉','份','',32,12.26],
  ['招牌烧鹅腿濑粉','烧鹅濑粉','份','切,不切',45,15.56],
  ['战斧大鹅翅濑粉','烧鹅濑粉','份','切,不切',38,15.56],
  ['斋濑粉','烧鹅濑粉','份','',8,3.86],
  ['蜜汁鸡翅','开心加料','个','切,不切',9.8,3.90],
  ['招牌烧鹅','开心加料','份/100g','',15,6.00],
  ['招牌烧鹅腿','开心加料','个','切,不切',40,11.40],
  ['鲜甜菜心/生菜','开心加料','份','',8,null],
  ['招牌烧鸭','开心加料','份/100g','',10,2.66],
  ['金牌烧鸭腿','开心加料','个','切,不切',23,4.13],
  ['溏心蛋','开心加料','个','',3,0.80],
  ['蜜汁叉烧','开心加料','份/100g','',10,6.16],
  ['咸香靓鸡腿','开心加料','个','切,不切',23,4.30],
  ['咸鸭蛋','开心加料','个','',3,0.80],
  ['咸香靓鸡','开心加料','份/80g','',10,2.88],
  ['脆皮烧肉','开心加料','份/60g','',10,3.96],
  ['上头柠檬茶','来杯特饮','杯','',8,6.00],
  ['冰镇冻柠乐','来杯特饮','杯','',8,2.60],
  ['冰镇冻柠七','来杯特饮','杯','',8,2.60],
  ['泰国咸柠七','来杯特饮','杯','',12,3.18],
  ['招牌太公烧鹅','烧味例牌','上庄','',68,30.00],
  ['招牌太公烧鹅','烧味例牌','下庄','',78,33.00],
  ['金牌现烤烧鸭','烧味例牌','上庄','',25,9.30],
  ['金牌现烤烧鸭','烧味例牌','下庄','',30,9.30],
  ['金牌现烤烧鸭','烧味例牌','半只','',55,20.00],
  ['咸香靓鸡','烧味例牌','半只','',45,20.70],
  ['蜜汁叉烧','烧味例牌','份','',35,15.04],
  ['澳门烧肉','烧味例牌','份','',35,16.50],
];

function splitSpec(spec) {
  const [unit, weight = ''] = spec.split('/');
  return { unit, weight };
}

async function main() {
  await db.init();
  const legacy = db.queryOne('SELECT COUNT(*) total FROM menu_items WHERE store_id=1');
  if (Number(legacy?.total || 0) && Number(legacy.total) !== 45) {
    throw new Error(`旧版集团目录应为 45 条，实际为 ${legacy.total} 条，已停止导入`);
  }

  db.exec('BEGIN');
  try {
    db.run('DELETE FROM menu_items WHERE store_id=1 OR store_id IS NULL');
    for (const [name, category, spec, method, price, cost, memberPrice = 0] of catalog) {
      const { unit, weight } = splitSpec(spec);
      db.insert(
        `INSERT INTO menu_items
          (store_id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost,expiry_days,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [null, name, category, method, spec, price, price, memberPrice, 0, unit, weight, cost, null, '在售']
      );
    }
    db.exec('COMMIT');
    db.save();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const summary = db.queryOne('SELECT COUNT(*) total,COUNT(DISTINCT name) dishes FROM menu_items WHERE store_id IS NULL');
  console.log(`已导入集团菜品目录：${summary.total} 条规格记录，${summary.dishes} 个菜品名称`);
  db.close();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
