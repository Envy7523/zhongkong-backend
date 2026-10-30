<template>
  <section class="inventory-page" aria-label="门店库存">
    <header class="inventory-heading">
      <div><h1>门店库存</h1><p>营业用料与员工餐分开记账，按实际收货、耗用和盘点更新数量。</p></div>
      <el-button v-if="context.capabilities?.configure" class="material-settings" :icon="Setting" @click="newMaterial">物料设置</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

    <div class="inventory-controls">
      <div class="inventory-scope">
        <label class="store-filter"><span>门店</span><el-select v-model="storeId" aria-label="库存门店" placeholder="选择负责门店" @change="changeStore"><el-option v-for="s in context.stores" :key="s.id" :value="s.id" :label="s.store_name" /></el-select></label>
        <div class="purpose-switch" role="group" aria-label="库存用途"><button v-for="p in context.purposes" :key="p.id" type="button" :aria-pressed="purpose===p.id" :class="{selected:purpose===p.id}" @click="selectPurpose(p.id)">{{p.name}}</button></div>
      </div>
      <div class="inventory-primary-actions">
        <el-button v-if="context.capabilities?.receive" type="primary" :disabled="!stock.length||busy" @click="start('receipt')">登记收货</el-button>
        <el-button v-if="context.capabilities?.close" :disabled="!stock.length||busy" @click="start('closing')">晚间收档</el-button>
        <el-button :icon="Refresh" :loading="busy" aria-label="刷新库存" title="刷新库存" :disabled="!storeId" @click="refresh" />
      </div>
    </div>

    <el-tabs v-model="tab" class="inventory-tabs">
      <el-tab-pane label="库存总览" name="stock">
        <template #label><span class="inventory-tab-label">库存总览<span v-if="stock.length" class="tab-count">{{stock.length}}</span></span></template>
        <div class="inventory-toolbar stock-toolbar">
          <div class="stock-caption"><strong>{{purposeName}}</strong><span>{{stock.length ? `已建账 ${stock.length} 项 · 仅含已确认数量` : '尚未建账'}}</span></div>
          <div class="stock-tools">
            <el-input v-if="stock.length" v-model="stockSearch" class="stock-search" :prefix-icon="Search" clearable aria-label="搜索库存物料" placeholder="搜索物料名称或编码" />
            <el-button v-if="stock.length&&context.capabilities?.confirm" @click="start('opening')">补充期初盘点</el-button>
          </div>
        </div>
        <div v-if="!stock.length" v-loading="busy" class="inventory-empty" :aria-busy="busy">
          <template v-if="!busy&&!error">
            <div class="inventory-empty-icon" aria-hidden="true"><el-icon><Box /></el-icon></div>
            <h2>{{!storeId?'暂无可查看的门店':`还没有建立${purposeName}库存`}}</h2>
            <p v-if="!storeId">请联系管理员配置门店范围与库存权限。</p>
            <p v-else-if="!activeMaterials.length">先添加共用物料，再录入本门店的初始实际数量。</p>
            <p v-else>物料已准备好，录入初始实际数量后即可开始收货与每日收档。</p>
            <div v-if="storeId" class="setup-steps" aria-label="库存建账步骤"><span :class="{done:activeMaterials.length}"><i>1</i>维护物料</span><b aria-hidden="true">›</b><span><i>2</i>期初盘点</span><b aria-hidden="true">›</b><span><i>3</i>收货与收档</span></div>
            <el-button v-if="storeId&&!activeMaterials.length&&context.capabilities?.configure" type="primary" @click="newMaterial">添加库存物料</el-button>
            <el-button v-else-if="storeId&&activeMaterials.length&&context.capabilities?.confirm" type="primary" @click="start('opening')">开始期初盘点</el-button>
            <small v-else-if="storeId">请联系有权限的人员完成物料维护和期初盘点。</small>
            <small v-if="storeId&&activeMaterials.length&&context.capabilities?.confirm">营业与员工餐需分别盘点，零库存也要明确填写。</small>
          </template>
        </div>
        <template v-else>
          <el-table v-loading="busy" :data="filteredStock" class="stock-table" empty-text="未找到匹配的物料，请调整搜索条件。">
            <el-table-column label="物料 / 规格" min-width="230"><template #default="{row}"><strong class="material-name">{{row.name}}</strong><small class="block">{{row.code}}</small></template></el-table-column>
            <el-table-column label="账面剩余" min-width="140" align="right"><template #default="{row}"><strong class="stock-quantity">{{row.quantity}}</strong><span class="quantity-unit">{{row.unit}}</span></template></el-table-column>
            <el-table-column label="最近实盘" min-width="190"><template #default="{row}">{{row.last_count?`${row.last_count.quantity} ${row.unit}`:'尚未盘点'}}<small class="block">{{row.last_count?.date||'未盘不代表零库存'}}</small></template></el-table-column>
            <el-table-column v-if="context.capabilities?.confirm" label="操作" width="120" align="right"><template #default="{row}"><el-button link type="primary" @click="start('adjustment',row)">盘点更正</el-button></template></el-table-column>
          </el-table>
          <div v-loading="busy" class="stock-mobile-list">
            <article v-for="row in filteredStock" :key="row.item_id" class="stock-mobile-item">
              <div class="stock-mobile-top"><div><strong class="material-name">{{row.name}}</strong><small class="block">{{row.code}}</small></div><div class="stock-mobile-quantity"><strong class="stock-quantity">{{row.quantity}}</strong><span class="quantity-unit">{{row.unit}}</span><small>账面剩余</small></div></div>
              <div class="stock-mobile-bottom"><small>最近实盘：{{row.last_count?`${row.last_count.quantity} ${row.unit} · ${row.last_count.date}`:'尚未盘点'}}</small><el-button v-if="context.capabilities?.confirm" link type="primary" @click="start('adjustment',row)">盘点更正</el-button></div>
            </article>
            <p v-if="!filteredStock.length" class="search-empty">未找到匹配的物料，请调整搜索条件。</p>
          </div>
          <p class="inventory-footnote">各物料按基础单位独立计量；借出和归还不算耗用，待还数量不重复计入库存。</p>
        </template>
      </el-tab-pane>

      <el-tab-pane label="收货与出入单" name="documents">
        <template #label><span class="inventory-tab-label">收货与出入单<el-tooltip v-if="pendingDocuments" content="当前用途最近50张记录中的待确认单据"><span class="tab-count tab-count-warning">{{pendingDocuments}} 待确认</span></el-tooltip></span></template>
        <div class="inventory-toolbar"><span>草稿提交后，由有权限的人员核对入账。</span><div class="toolbar-actions"><el-button v-if="context.capabilities?.close" @click="start('loss')">登记报损</el-button><el-button v-if="context.capabilities?.receive" @click="start('purchase_return')">采购退货</el-button></div></div>
        <el-table :data="documents" @row-click="openDetail"><el-table-column prop="id" label="单号" width="85" /><el-table-column prop="business_date" label="营业日" width="130" /><el-table-column prop="kind_label" label="类型" width="120" /><el-table-column label="订单来源" min-width="150"><template #default="{row}">{{context.sources?.[row.payload.source_key]?.name||'门店手工登记'}}<small class="block">{{row.payload.order_ref}}</small></template></el-table-column><el-table-column label="状态" width="105"><template #default="{row}">{{statuses[row.status]}}</template></el-table-column><el-table-column prop="creator_name" label="填报人" width="120" /><el-table-column label="操作" width="95"><template #default="{row}"><el-button link type="primary" @click.stop="openDetail(row)">查看</el-button></template></el-table-column></el-table>
        <el-pagination v-model:current-page="page" :page-size="50" :total="total" layout="prev, pager, next" @current-change="refresh" />
      </el-tab-pane>

      <el-tab-pane label="每日收档" name="closing">
        <div class="closing-note"><div><h2>{{purposeName}} · 每日收档</h2><p>分别填写今日耗用与现场实盘，未盘点可留空。已登记的借还、转料和报损不要重复填入耗用。</p></div></div>
        <el-table :data="documents.filter(d=>d.kind==='closing')" @row-click="openDetail"><el-table-column prop="business_date" label="营业日" /><el-table-column prop="creator_name" label="填报人" /><el-table-column label="状态"><template #default="{row}">{{statuses[row.status]}}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click.stop="openDetail(row)">查看收档</el-button></template></el-table-column></el-table>
      </el-tab-pane>

      <el-tab-pane label="借货与归还" name="loans">
        <template #label><span class="inventory-tab-label">借货与归还<el-tooltip v-if="outstandingLoans" content="当前借还列表中尚未还清的记录数"><span class="tab-count">{{outstandingLoans}} 待还</span></el-tooltip></span></template>
        <div class="inventory-toolbar"><span>营业与员工餐之间借还，双方库存同步变动。</span><div class="toolbar-actions"><el-button v-if="context.capabilities?.transfer" @click="start('transfer')">直接转用</el-button><el-button v-if="context.capabilities?.transfer" type="primary" @click="start('borrow')">借货登记</el-button></div></div>
        <el-table :data="loans"><el-table-column prop="document_id" label="借货单" width="90" /><el-table-column prop="name" label="物料" min-width="120" /><el-table-column label="流向" min-width="180"><template #default="{row}">{{names[row.from_purpose]}} → {{names[row.to_purpose]}}</template></el-table-column><el-table-column prop="lent" label="借出" /><el-table-column prop="returned" label="已还" /><el-table-column prop="waived" label="已转直接使用" min-width="130" /><el-table-column prop="remaining" label="待还" /><el-table-column prop="unit" label="单位" width="75" /><el-table-column label="操作" min-width="180"><template #default="{row}"><template v-if="row.remaining>0&&context.capabilities?.transfer"><el-button link type="primary" @click="repay(row)">登记归还</el-button><el-button v-if="context.capabilities?.confirm" link @click="conversion=row;convertQuantity='';convertReason=''">转为直接使用</el-button></template></template></el-table-column></el-table>
      </el-tab-pane>
    </el-tabs>
    <NotificationDialog v-model="formVisible" :title="`${context.kinds?.[form.kind]||'库存单据'} · ${names[form.purpose]||''}`" subtitle="数量最多三位小数。保存草稿不改变库存，确认后才入账。" width="min(1000px,96vw)" :close-on-click-modal="false">
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
      <el-form label-position="top" class="inventory-form"><div class="inventory-form-head"><el-form-item label="营业日期"><el-date-picker v-model="form.business_date" type="date" value-format="YYYY-MM-DD" :disabled="!!form.id" /></el-form-item><el-form-item v-if="form.kind==='receipt'" label="订单来源（用途已对应）"><el-input :model-value="form.source_key==='lcx'?'绿春翔':'绿春翔员工餐'" disabled /></el-form-item><el-form-item v-if="form.kind==='receipt'" label="原订单／独立送货单号"><el-input v-model="form.order_ref" maxlength="100" placeholder="两个来源的订单分别入账" /></el-form-item><el-form-item v-if="['borrow','transfer'].includes(form.kind)" label="目标用途"><el-input :model-value="names[form.to_purpose]" disabled /></el-form-item><el-form-item v-if="form.kind==='repayment'" label="关联借货单"><el-input :model-value="String(form.loan_id)" disabled /></el-form-item></div>
        <el-table :data="form.lines" class="inventory-line-table inventory-line-desktop"><el-table-column label="物料" min-width="210"><template #default="{row}"><el-select v-model="row.item_id" :disabled="['closing','adjustment','repayment'].includes(form.kind)" filterable aria-label="单据物料"><el-option v-for="i in formMaterials" :key="i.id" :value="i.id" :label="`${i.name} · ${i.code} / ${i.unit}`" /></el-select></template></el-table-column><el-table-column label="单位" width="70"><template #default="{row}">{{materials.find(i=>i.id===row.item_id)?.unit}}</template></el-table-column>
          <el-table-column v-if="form.kind==='closing'" label="今日耗用（不含额外报损）" min-width="170"><template #default="{row}"><el-input v-model="row.consumed" inputmode="decimal" aria-label="今日耗用" placeholder="请填写，未用填0" /></template></el-table-column>
          <el-table-column v-if="form.kind==='closing'" label="额外报损" min-width="120"><template #default="{row}"><el-input v-model="row.loss" inputmode="decimal" aria-label="额外报损" /></template></el-table-column>
          <el-table-column v-if="['opening','closing','adjustment'].includes(form.kind)" :label="form.kind==='closing'?'实盘剩余（未盘留空）':'实盘数量'" min-width="170"><template #default="{row}"><el-input v-model="row.counted" inputmode="decimal" aria-label="实盘数量" :placeholder="form.kind==='closing'?'未盘留空':'零库存请填0'" /></template></el-table-column>
          <el-table-column v-if="form.kind==='receipt'" label="订货数量" min-width="130"><template #default="{row}"><el-input v-model="row.ordered_quantity" inputmode="decimal" aria-label="订货数量" placeholder="选填" /></template></el-table-column>
          <el-table-column v-if="!['opening','closing','adjustment'].includes(form.kind)" :label="form.kind==='receipt'?'实际签收数量':'实际交接数量'" min-width="140"><template #default="{row}"><el-input v-model="row.quantity" inputmode="decimal" aria-label="实际数量" /></template></el-table-column>
          <el-table-column v-if="!['closing','adjustment','repayment'].includes(form.kind)" width="80"><template #default="{$index}"><el-button link type="danger" @click="form.lines.splice($index,1)">移除</el-button></template></el-table-column>
        </el-table>
        <div class="inventory-line-cards">
          <article v-for="(line,index) in form.lines" :key="index" class="inventory-line-card">
            <div class="line-mobile-heading"><div><strong>{{materialInfo(line.item_id).name||`物料 ${index+1}`}}</strong><small v-if="line.item_id" class="block">{{materialInfo(line.item_id).code}} · {{materialInfo(line.item_id).unit}}</small></div><el-button v-if="!['closing','adjustment','repayment'].includes(form.kind)" link type="danger" @click="form.lines.splice(index,1)">移除</el-button></div>
            <label v-if="!['closing','adjustment','repayment'].includes(form.kind)" class="line-material-select"><span>选择物料</span><el-select v-model="line.item_id" filterable aria-label="单据物料"><el-option v-for="i in formMaterials" :key="i.id" :value="i.id" :label="`${i.name} / ${i.unit}`" /></el-select></label>
            <div class="line-mobile-fields">
              <template v-if="form.kind==='closing'"><label><span>今日耗用</span><el-input v-model="line.consumed" inputmode="decimal" aria-label="今日耗用" placeholder="未用填0" /></label><label><span>额外报损</span><el-input v-model="line.loss" inputmode="decimal" aria-label="额外报损" /></label></template>
              <label v-if="['opening','closing','adjustment'].includes(form.kind)" class="line-counted"><span>{{form.kind==='closing'?'实盘剩余（未盘留空）':'实盘数量'}}</span><el-input v-model="line.counted" inputmode="decimal" aria-label="实盘数量" :placeholder="form.kind==='closing'?'未盘留空':'数量可为0'" /></label>
              <label v-if="form.kind==='receipt'"><span>原单数量（选填）</span><el-input v-model="line.ordered_quantity" inputmode="decimal" aria-label="原单数量" /></label>
              <label v-if="!['opening','closing','adjustment'].includes(form.kind)"><span>{{form.kind==='receipt'?'实际签收数量':'实际交接数量'}}</span><el-input v-model="line.quantity" inputmode="decimal" aria-label="实际数量" /></label>
            </div>
          </article>
        </div>
        <el-button v-if="!['closing','adjustment','repayment','borrow'].includes(form.kind)" class="add-row" @click="form.lines.push(blankLine())">＋ 添加物料</el-button>
        <el-form-item label="用途、短收或差异说明"><el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="formVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveDraft">保存草稿</el-button></template>
    </NotificationDialog>
    <el-drawer v-model="detailVisible" :title="detail?`${detail.kind_label} #${detail.id}`:'单据详情'" size="min(820px,96vw)"><template v-if="detail"><div class="detail-meta"><span>{{names[detail.purpose]}} · {{detail.business_date}}</span><el-tag>{{statuses[detail.status]}}</el-tag></div><p>{{detail.payload.note||'无附加说明'}}</p><p v-if="detail.payload.order_ref">订单：{{detail.payload.order_ref}}</p><el-table :data="detail.payload.lines"><el-table-column prop="name" label="物料" /><el-table-column prop="unit" label="单位" width="75" /><el-table-column label="登记数量"><template #default="{row}"><template v-if="detail.kind==='closing'">耗用 {{row.consumed}} / 报损 {{row.loss}} / 实盘 {{row.counted??'未盘'}}</template><template v-else>{{row.quantity??row.counted}}</template></template></el-table-column></el-table><template v-if="detail.checks?.length"><h3>确认前核对</h3><el-table :data="detail.checks"><el-table-column prop="name" label="物料" /><el-table-column prop="before" label="登记前库存" /><el-table-column prop="expected" label="账面应余" /><el-table-column label="实盘"><template #default="{row}">{{row.counted??'未盘'}}</template></el-table-column><el-table-column label="差额"><template #default="{row}">{{row.difference??'未核对'}} <el-tag v-if="row.stale" type="warning">库存已变化</el-tag></template></el-table-column></el-table></template><div class="detail-actions"><el-button v-if="detail.status==='draft'" @click="editDetail">编辑草稿</el-button><el-button v-if="detail.status==='draft'" :loading="saving" @click="doAction('submit')">提交确认</el-button><el-button v-if="detail.status==='draft'" :loading="saving" @click="doAction('cancel')">撤销草稿</el-button><template v-if="detail.status==='submitted'&&context.capabilities?.confirm"><el-input v-model="rejectReason" placeholder="退回修改时填写原因" /><el-button @click="doAction('reject')">退回修改</el-button><el-button type="primary" :loading="saving" @click="askConfirm">确认并入账</el-button></template></div><h3>确认后的库存流水</h3><el-table :data="detail.movements" empty-text="尚未过账"><el-table-column prop="name" label="物料" /><el-table-column label="用途"><template #default="{row}">{{names[row.purpose]}}</template></el-table-column><el-table-column prop="delta" label="变动" /><el-table-column prop="balance_after" label="变动后" /><el-table-column prop="actor_name" label="确认人" /></el-table><h3>处理记录</h3><p v-for="(e,i) in detail.events" :key="i" class="event-row">{{e.actor_name}} · {{eventName[e.action]||e.action}} · {{time(e.created_at)}}</p></template></el-drawer>
    <NotificationDialog v-model="confirmVisible" title="确认库存入账" tone="warning" subtitle="请核对实际数量、用途和营业日期。确认后保留流水，不能直接覆盖。"><p>确认将本张{{detail?.kind_label}}记入库存？借还不计作耗用；收档实盘差异会形成独立调整。</p><template #footer><el-button @click="confirmVisible=false">返回核对</el-button><el-button type="primary" :loading="saving" @click="doAction('confirm')">确认入账</el-button></template></NotificationDialog>
    <NotificationDialog :model-value="!!conversion" title="将未还数量转为直接使用" tone="warning" @update:model-value="v=>{if(!v)conversion=null}"><p>本操作仅关闭对应待还数量，不会再转移一次库存。</p><el-form label-position="top"><el-form-item label="转为直接使用的数量"><el-input v-model="convertQuantity" inputmode="decimal" /></el-form-item><el-form-item label="不再归还的原因"><el-input v-model="convertReason" type="textarea" maxlength="500" /></el-form-item></el-form><template #footer><el-button @click="conversion=null">取消</el-button><el-button type="primary" :loading="saving" @click="convertLoan">确认转换</el-button></template></NotificationDialog>
    <InventoryMaterials v-model="materialVisible" :api="api" @updated="materialsUpdated" />
  </section>
</template>
<script setup>
import {ref,computed,onMounted} from 'vue'
import {inventoryApi} from '@/api'
import {Box,Refresh,Search,Setting} from '@element-plus/icons-vue'
import NotificationDialog from '@/components/NotificationDialog.vue'
import InventoryMaterials from './InventoryMaterials.vue'
const props=defineProps({transport:{type:Object,default:null}}),api=props.transport||inventoryApi
const context=ref({stores:[],purposes:[],capabilities:{},sources:{},kinds:{}}),storeId=ref(null),purpose=ref('business'),tab=ref('stock'),busy=ref(false),saving=ref(false),error=ref(''),stock=ref([]),documents=ref([]),materials=ref([]),loans=ref([]),page=ref(1),total=ref(0)
const names={business:'营业用料',staff_meal:'员工餐用料'},statuses={draft:'草稿',submitted:'待确认',posted:'已入账',cancelled:'已撤销'},eventName={'document.create':'新建草稿','document.edit':'编辑草稿','document.submit':'提交','document.confirm':'确认入账','document.reject':'退回修改','document.cancel':'撤销草稿','loan.convert_to_transfer':'转为直接使用','loan.repayment':'收到归还'}
const purposeName=computed(()=>names[purpose.value]),formVisible=ref(false),form=ref({lines:[]}),formError=ref(''),detailVisible=ref(false),detail=ref(null),confirmVisible=ref(false),rejectReason=ref(''),conversion=ref(null),convertQuantity=ref(''),convertReason=ref(''),materialVisible=ref(false)
const stockSearch=ref('')
const activeMaterials=computed(()=>materials.value.filter(i=>i.active))
const formMaterials=computed(()=>materials.value.filter(i=>i.active&&(form.value.kind!=='receipt'||!i.supplier_ids?.length||i.supplier_ids.includes('lcx'))))
const filteredStock=computed(()=>{const q=stockSearch.value.trim().toLocaleLowerCase();return q?stock.value.filter(i=>`${i.name} ${i.code}`.toLocaleLowerCase().includes(q)):stock.value})
const pendingDocuments=computed(()=>documents.value.filter(d=>d.status==='submitted').length)
const outstandingLoans=computed(()=>loans.value.filter(l=>l.remaining>0).length)
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10)
const time=v=>new Date(new Date(v).getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ')
const materialInfo=id=>materials.value.find(i=>i.id===id)||{}
const blankLine=()=>({item_id:'',quantity:'',counted:'',ordered_quantity:''})
async function load(){busy.value=true;error.value='';try{context.value=await api.context();materials.value=(await api.items()).items;storeId.value=context.value.stores[0]?.id||null;purpose.value=context.value.purposes[0]?.id||'business';await refresh()}catch(e){error.value=e.message}finally{busy.value=false}}
async function refresh(){if(!storeId.value)return;busy.value=true;error.value='';try{const q={store_id:storeId.value,purpose:purpose.value,page:page.value};const [s,d,l]=await Promise.all([api.stock(q),api.documents(q),api.loans(q)]);stock.value=s.items;documents.value=d.items;total.value=d.total;loans.value=l.items}catch(e){stock.value=[];documents.value=[];loans.value=[];error.value=e.message}finally{busy.value=false}}
function changeStore(){page.value=1;stockSearch.value='';refresh()}
function selectPurpose(p){if(purpose.value===p)return;purpose.value=p;page.value=1;stockSearch.value='';refresh()}
function start(kind,row){if(!storeId.value){error.value='请先选择有权限的门店';return}if(!materials.value.some(i=>i.active)){error.value='请先由有权限人员维护共用物料';return}formError.value='';form.value={kind,store_id:storeId.value,purpose:purpose.value,business_date:today(),request_key:crypto.randomUUID(),note:'',source_key:purpose.value==='business'?'lcx':'lcx_staff_meal',order_ref:'',to_purpose:purpose.value==='business'?'staff_meal':'business',lines:kind==='closing'?stock.value.filter(i=>i.active).map(i=>({item_id:i.item_id,consumed:'',loss:'0',counted:'',balance_version:i.version})):row?[{item_id:row.item_id,counted:'',balance_version:row.version}]:[blankLine()]};if(kind==='closing'&&!form.value.lines.length){error.value='该用途尚未初始化库存，请先做期初盘点';return}formVisible.value=true}
function repay(l){purpose.value=l.to_purpose;form.value={kind:'repayment',store_id:storeId.value,purpose:l.to_purpose,business_date:today(),request_key:crypto.randomUUID(),loan_id:l.document_id,note:'',lines:[{item_id:l.item_id,quantity:''}]};formError.value='';formVisible.value=true}
async function saveDraft(){saving.value=true;formError.value='';try{const r=form.value.id?await api.update(form.value.id,form.value):await api.create(form.value);formVisible.value=false;await refresh();await openDetail(r.item)}catch(e){formError.value=e.message}finally{saving.value=false}}
async function openDetail(row){try{detail.value=(await api.detail(row.id)).item;rejectReason.value='';detailVisible.value=true}catch(e){error.value=e.message}}
async function editDetail(){try{const draft={...JSON.parse(JSON.stringify(detail.value.payload)),id:detail.value.id,version:detail.value.version};formError.value='';if(['closing','adjustment'].includes(draft.kind)){const current=(await api.stock({store_id:draft.store_id,purpose:draft.purpose})).items;if(draft.kind==='closing')draft.lines=current.filter(i=>i.active).map(i=>({...draft.lines.find(l=>l.item_id===i.item_id),item_id:i.item_id,consumed:draft.lines.find(l=>l.item_id===i.item_id)?.consumed??'',loss:draft.lines.find(l=>l.item_id===i.item_id)?.loss??'0',counted:'',balance_version:i.version}));else draft.lines=draft.lines.map(l=>({...l,counted:'',balance_version:current.find(i=>i.item_id===l.item_id)?.version}));formError.value='已刷新当前库存，请重新核对耗用并填写现场实盘；未盘可留空。'}form.value=draft;formVisible.value=true;detailVisible.value=false}catch(e){error.value=e.message}}
function askConfirm(){confirmVisible.value=true}
async function doAction(action){saving.value=true;error.value='';try{await api.action(detail.value.id,{action,version:detail.value.version,reason:rejectReason.value});confirmVisible.value=false;await openDetail(detail.value);await refresh()}catch(e){error.value=e.message;confirmVisible.value=false}finally{saving.value=false}}
async function convertLoan(){saving.value=true;try{await api.convert(conversion.value.document_id,{version:conversion.value.version,quantity:convertQuantity.value,reason:convertReason.value});conversion.value=null;await refresh()}catch(e){error.value=e.message}finally{saving.value=false}}
function newMaterial(){materialVisible.value=true}
async function materialsUpdated(){try{materials.value=(await api.items()).items;await refresh()}catch(e){error.value=e.message}}
onMounted(load)
</script>
<style scoped>
.inventory-page {
  container: inventory / inline-size;
  box-sizing: border-box;
  min-width: 0;
  max-width: 1560px;
  margin: 20px auto;
  padding: 22px 24px 24px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
}
.inventory-heading { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:20px; }
.inventory-heading h1 { margin:0 0 6px; font-size:22px; font-weight:600; line-height:1.4; letter-spacing:0; }
.inventory-heading p { margin:0; color:var(--el-text-color-secondary); font-size:13px; line-height:1.6; }
.material-settings { flex-shrink:0; }
.inventory-page > .el-alert { margin-bottom:16px; }
.inventory-controls { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; padding:14px 0 18px; border-top:1px solid var(--el-border-color-lighter); }
.inventory-scope { display:flex; align-items:center; flex-wrap:wrap; gap:18px; min-width:0; }
.store-filter { display:flex; align-items:center; gap:10px; min-width:0; font-size:13px; color:var(--el-text-color-regular); }
.store-filter > span { flex-shrink:0; }
.store-filter .el-select { width:250px; }
.purpose-switch { display:flex; align-items:center; gap:3px; padding:3px; border-radius:6px; background:var(--el-fill-color-light); }
.purpose-switch button { min-height:30px; padding:4px 14px; border:1px solid transparent; border-radius:4px; background:transparent; color:var(--el-text-color-regular); cursor:pointer; font:inherit; font-size:13px; line-height:1.5; white-space:nowrap; }
.purpose-switch button:hover { color:var(--el-color-primary); }
.purpose-switch .selected { border-color:var(--el-border-color-light); background:var(--el-bg-color); color:var(--el-color-primary); font-weight:600; box-shadow:0 1px 2px #152b4810; }
.inventory-primary-actions,.toolbar-actions,.stock-tools { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.inventory-page :deep(.el-button+.el-button) { margin-left:0; }
.inventory-tabs { min-width:0; }
.inventory-tabs :deep(.el-tabs__header) { margin:0; }
.inventory-tabs :deep(.el-tabs__nav-wrap::after) { height:1px; background:var(--el-border-color-light); }
.inventory-tabs :deep(.el-tabs__item) { height:46px; padding:0 20px; font-size:13px; }
.inventory-tabs :deep(.el-tabs__item.is-active) { font-weight:600; }
.inventory-tabs :deep(.el-tabs__content),.inventory-tabs :deep(.el-tab-pane) { min-width:0; }
.inventory-tab-label { display:inline-flex; align-items:center; gap:7px; }
.tab-count { padding:1px 6px; border-radius:4px; background:var(--el-fill-color); color:var(--el-text-color-secondary); font-size:11px; line-height:18px; font-weight:500; }
.tab-count-warning { color:var(--el-color-warning); background:var(--el-color-warning-light-9); }
.inventory-toolbar { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; padding:16px 0; }
.inventory-toolbar > span { color:var(--el-text-color-secondary); font-size:13px; line-height:1.6; }
.stock-caption { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.stock-caption > strong { font-size:14px; font-weight:600; }
.stock-caption > span { font-size:12px; color:var(--el-text-color-secondary); }
.stock-search { width:220px; }
.material-name { font-size:14px; font-weight:500; color:var(--el-text-color-primary); }
.stock-quantity { font-size:17px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--el-text-color-primary); }
.quantity-unit { margin-left:6px; font-size:12px; color:var(--el-text-color-secondary); }
.block { display:block; margin-top:3px; font-size:12px; line-height:1.5; color:var(--el-text-color-secondary); }
.inventory-page :deep(.el-table) { --el-table-header-bg-color:var(--el-fill-color-extra-light); --el-table-header-text-color:var(--el-text-color-secondary); }
.stock-table :deep(.el-table__cell) { padding:13px 0; }
.stock-table :deep(th.el-table__cell) { padding:10px 0; font-size:12px; font-weight:500; }
.stock-mobile-list { display:none; }
.inventory-footnote { margin:12px 0 0; font-size:12px; line-height:1.6; color:var(--el-text-color-secondary); }
.inventory-empty { display:flex; min-height:270px; box-sizing:border-box; flex-direction:column; align-items:center; justify-content:center; padding:30px 16px 34px; border:1px dashed var(--el-border-color); border-radius:6px; background:var(--el-fill-color-extra-light); text-align:center; }
.inventory-empty-icon { display:grid; place-items:center; width:48px; height:48px; margin-bottom:14px; border:1px solid var(--el-border-color-light); border-radius:12px; background:var(--el-bg-color); color:var(--el-color-primary); font-size:24px; }
.inventory-empty h2 { margin:0 0 8px; font-size:17px; font-weight:600; line-height:1.5; }
.inventory-empty p { margin:0; max-width:440px; color:var(--el-text-color-secondary); font-size:13px; line-height:1.7; }
.inventory-empty > small { display:block; margin-top:12px; color:var(--el-text-color-secondary); font-size:12px; line-height:1.6; }
.setup-steps { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:14px; margin:22px 0; font-size:12px; color:var(--el-text-color-regular); }
.setup-steps > span { display:flex; align-items:center; gap:6px; }
.setup-steps i { display:grid; place-items:center; width:19px; height:19px; border-radius:50%; background:var(--el-fill-color); color:var(--el-text-color-secondary); font-style:normal; font-size:11px; }
.setup-steps .done i { background:var(--el-color-success-light-9); color:var(--el-color-success); }
.setup-steps > b { color:var(--el-text-color-placeholder); font-weight:400; }
.closing-note { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px 0; }
.closing-note h2 { margin:0 0 6px; font-size:15px; font-weight:600; }
.closing-note p { margin:0; max-width:680px; font-size:13px; line-height:1.7; color:var(--el-text-color-secondary); }
.closing-note > .el-button { flex-shrink:0; }
.el-pagination { margin:18px 0 0; }
.inventory-form { container: inventory-form / inline-size; }
.inventory-form :deep(.el-date-editor.el-input) { width:100%; }
.inventory-line-cards { display:none; }
.inventory-form-head { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 18px; }
.inventory-line-table { margin-bottom:18px; }
.add-row { margin-bottom:18px; }
.detail-meta { display:flex; justify-content:space-between; gap:15px; margin-bottom:18px; }
.detail-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:22px 0; }
.detail-actions .el-input { max-width:280px; }
.event-row { font-size:13px; line-height:1.7; color:var(--el-text-color-secondary); }
button:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:3px; }
@container inventory (max-width: 850px) {
  .inventory-controls { align-items:flex-start; }
  .inventory-scope { gap:12px; }
  .store-filter .el-select { width:220px; }
  .inventory-primary-actions { margin-left:auto; }
}
@container inventory (max-width: 640px) {
  .inventory-heading { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px 12px; margin-bottom:16px; }
  .inventory-heading > div { display:contents; }
  .inventory-heading h1 { grid-column:1; grid-row:1; margin-bottom:0; }
  .inventory-heading p { grid-column:1/-1; grid-row:2; }
  .material-settings { grid-column:2; grid-row:1; }
  .inventory-heading h1 { font-size:20px; }
  .inventory-heading p { font-size:12px; }
  .material-settings { padding:8px 10px; font-size:12px; }
  .inventory-controls { gap:12px; padding:14px 0; }
  .inventory-scope { width:100%; gap:12px; }
  .store-filter { width:100%; }
  .store-filter .el-select { flex:1; width:auto; }
  .purpose-switch { flex:1; }
  .purpose-switch button { flex:1; min-height:36px; padding:4px 10px; }
  .inventory-primary-actions { width:100%; margin:0; }
  .inventory-primary-actions > .el-button:not(:last-child) { flex:1; }
  .inventory-primary-actions > .el-button { min-height:36px; }
  .inventory-tabs :deep(.el-tabs__item) { height:44px; padding:0 12px; font-size:12px; }
  .inventory-toolbar { gap:12px; }
  .stock-caption { justify-content:space-between; width:100%; gap:8px; }
  .stock-tools { width:100%; flex-wrap:nowrap; }
  .stock-search { flex:1; width:auto; min-width:0; }
  .stock-tools .el-button { padding:8px 10px; font-size:12px; }
  .stock-table { display:none; }
  .stock-mobile-list { display:grid; gap:10px; }
  .stock-mobile-item { padding:14px; border:1px solid var(--el-border-color-light); border-radius:6px; }
  .stock-mobile-top { display:flex; justify-content:space-between; gap:12px; }
  .stock-mobile-top > div:first-child { min-width:0; overflow-wrap:anywhere; }
  .stock-mobile-quantity { flex-shrink:0; text-align:right; }
  .stock-mobile-quantity > small { display:block; margin-top:3px; font-size:11px; color:var(--el-text-color-secondary); }
  .stock-mobile-bottom { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid var(--el-border-color-lighter); }
  .stock-mobile-bottom > small { font-size:11px; color:var(--el-text-color-secondary); line-height:1.6; }
  .stock-mobile-bottom .el-button { min-height:32px; }
  .inventory-empty { min-height:270px; padding:24px 14px; }
  .setup-steps { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; width:100%; max-width:300px; align-items:start; font-size:11px; }
  .setup-steps > span { flex-direction:column; gap:6px; white-space:nowrap; }
  .setup-steps > b { display:none; }
  .closing-note { align-items:flex-start; flex-direction:column; gap:12px; }
  .toolbar-actions { width:100%; }
  .toolbar-actions > .el-button { min-height:36px; }
  .inventory-form-head { grid-template-columns:1fr; }
}
@container inventory-form (max-width: 640px) {
  .inventory-form-head { grid-template-columns:1fr; }
  .inventory-line-desktop { display:none; }
  .inventory-line-cards { display:grid; gap:12px; margin-bottom:18px; }
  .inventory-line-card { min-width:0; padding:14px; border:1px solid var(--el-border-color-light); border-radius:6px; }
  .line-mobile-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
  .line-mobile-heading strong { font-size:14px; font-weight:600; }
  .line-material-select { display:grid; gap:6px; margin-bottom:12px; font-size:12px; color:var(--el-text-color-regular); }
  .line-material-select .el-select { width:100%; }
  .line-mobile-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .line-mobile-fields label { display:grid; gap:6px; min-width:0; font-size:12px; color:var(--el-text-color-regular); }
  .line-mobile-fields .line-counted { grid-column:1/-1; }
  .line-mobile-fields :deep(.el-input__wrapper) { min-height:36px; box-sizing:border-box; }
}
@media (max-width:760px) { .inventory-page { margin:12px auto; padding:18px 14px; } }
</style>
