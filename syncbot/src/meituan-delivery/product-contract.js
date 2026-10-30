'use strict';
const identityFields=['日期','商品名','门店所在城市','门店名称','门店id'];
const metrics=['商品销量','商品销售额','订单交易额','带来订单量','下单人数','是否拼好饭','是否神抢手一口价商品'];
module.exports={reportType:'meituan_delivery_product',prefix:'商品',identityFields,metrics,fields:[...identityFields,...metrics]};
