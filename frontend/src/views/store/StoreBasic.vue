<template>
  <main class="store-basic-page">
    <section class="page-hero">
      <div>
        <span class="eyebrow">STORE DIRECTORY</span>
        <h2>门店基本信息</h2>
        <p>集中维护门店档案。先建立门店，再到“门店区域管理”划分归属区域；闭店与迁址请用行内「更多」里的专用操作。</p>
      </div>
      <el-button type="primary" size="large" class="create-store-button" @click="openCreate">+ 新建门店</el-button>
    </section>

    <section class="stats-grid">
      <article class="stat-card"><span>门店总数</span><b>{{ stats.total ?? total ?? '—' }}</b><small>含已闭店</small></article>
      <article class="stat-card positive"><span>已开业</span><b>{{ stats.open_count ?? '—' }}</b><small>正常营业门店</small></article>
      <article class="stat-card warning"><span>筹建中</span><b>{{ stats.planning_count ?? '—' }}</b><small>待开业门店</small></article>
      <article class="stat-card info-card"><span>已闭店</span><b>{{ stats.closed_count ?? '—' }}</b><small>移入「闭店门店」分组</small></article>
      <article class="stat-card violet"><span>联营 / 加盟</span><b>{{ joinedStoreCount }}</b><small>联营 {{ stats.joint_count ?? 0 }} · 加盟 {{ stats.franchise_count ?? 0 }}</small></article>
    </section>
    <p v-if="Number(stats.relocated_in_count)" class="stats-note">
      其中 <b>{{ stats.relocated_in_count }}</b> 家是<b>迁址而来</b>（非全新开门店）；全新开门 <b>{{ stats.newly_opened_count }}</b> 家。
      迁址店只记录新店自己的数据，与原店的关系在「门店履历」里可查。
    </p>

    <section class="directory-card">
      <header class="directory-header">
        <div><span class="section-kicker">STORE LIST</span><h3>门店档案</h3><p>共 {{ total }} 家门店，可按名称、状态、店型或法人查找。</p></div>
        <el-button plain @click="resetFilters">重置筛选</el-button>
      </header>
      <div class="filters">
        <el-input v-model="keyword" clearable placeholder="搜索门店名称" @keyup.enter="search" />
        <el-select v-model="status" clearable placeholder="全部状态"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="storeType" clearable placeholder="全部店型"><el-option v-for="item in typeOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-input v-model="legalPerson" clearable placeholder="法人名称" @keyup.enter="search" />
        <el-button type="primary" @click="search">查询</el-button>
      </div>
      <el-table :data="stores" v-loading="loading" stripe class="store-table" :row-class-name="rowClass" empty-text="暂无门店，点击右上角“新建门店”开始录入">
        <!-- 序号必须也在最左固定：门店名称列带 fixed="left" 时会被渲染到最左侧，
             把非固定的 # 挤到它右边。两列都固定后按声明顺序排列 => # | 门店名称 -->
        <el-table-column type="index" label="序号" width="64" fixed="left" align="center" />
        <el-table-column label="门店名称 / 机构编码" min-width="244" fixed="left">
          <template #default="{ row }">
            <div class="store-cell">
              <div>
                <span :class="{ 'name-closed': isClosed(row) }">{{ row.store_name }}</span>
                <el-tag v-if="row.relocated_from_store_id" size="small" type="warning" effect="plain" class="mini-tag">迁址而来</el-tag>
              </div>
              <small v-if="row.pos_store_code" class="code-line">机构编码 {{ row.pos_store_code }}</small>
              <small v-else class="code-line code-missing">未绑定机构编码</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTag(row.status)" effect="plain" size="small">{{ row.status || '—' }}</el-tag></template></el-table-column>
        <el-table-column prop="store_type" label="店型" width="94" />
        <el-table-column prop="legal_person" label="法人" width="108" show-overflow-tooltip />
        <el-table-column label="所在地区" min-width="150"><template #default="{ row }">{{ [row.province, row.city, row.district].filter(Boolean).join(' / ') || '—' }}</template></el-table-column>
        <el-table-column prop="address" label="详细地址" min-width="200" show-overflow-tooltip />
        <el-table-column prop="opening_date" label="开业日期" width="112" />
        <el-table-column label="闭店" width="150">
          <template #default="{ row }">
            <span v-if="row.closed_date">{{ row.closed_date }}</span>
            <el-tag v-if="row.closed_type" size="small" :type="row.closed_type === '迁址' ? 'warning' : 'info'" effect="plain" class="mini-tag">{{ row.closed_type }}</el-tag>
            <span v-if="!row.closed_date && !row.closed_type">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-dropdown trigger="click" @command="cmd => onAction(cmd, row)">
              <el-button type="primary" link>更多<el-icon class="el-icon--right"><arrow-down /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="lifecycle">门店履历</el-dropdown-item>
                  <el-dropdown-item v-if="isClosed(row)" command="reopen" divided>重开</el-dropdown-item>
                  <template v-else>
                    <el-dropdown-item command="relocate" divided>发起迁址</el-dropdown-item>
                    <el-dropdown-item command="close">闭店</el-dropdown-item>
                  </template>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="total > pageSize" v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" class="pagination" @current-change="loadData" />
    </section>

    <!-- ===== 新建 / 编辑门店 ===== -->
    <el-dialog v-model="formVisible" :title="creating ? '新建门店' : `编辑门店 · ${form.store_name || ''}`" width="min(820px, calc(100vw - 32px))" destroy-on-close class="store-form-dialog">
      <div class="dialog-intro"><b>{{ creating ? '录入新门店' : '维护门店档案' }}</b><span>带 <em>*</em> 的字段为必填项；其他资料可在以后补充。</span></div>
      <el-alert v-if="!creating && isClosed(form)" type="info" :closable="false" show-icon class="closed-alert"
        :title="`该门店已闭店（${form.closed_date || '未填日期'}${form.closed_type ? ' · ' + form.closed_type : ''}）`"
        description="闭店门店的资料仍可查阅。若要恢复营业，请用「重开」；闭店日期与类型不在本弹窗修改，以保证履历可追溯。" />
      <el-form label-position="top" class="store-form">
        <section class="form-section"><h4>基础资料</h4>
          <div class="form-grid three">
            <el-form-item label="门店名称" required><el-input v-model="form.store_name" placeholder="例如：鹅太公烧鹅（龙岗万科店）" /></el-form-item>
            <el-form-item label="经营状态">
              <el-select v-model="form.status" :disabled="!creating && isClosed(form)">
                <el-option v-for="item in formStatusOptions" :key="item" :label="item" :value="item" />
              </el-select>
              <small class="field-hint">闭店 / 迁址请用行内「更多」中的专用操作（会校验员工处置并留履历）</small>
            </el-form-item>
            <el-form-item label="门店类型"><el-select v-model="form.store_type"><el-option v-for="item in typeOptions" :key="item" :label="item" :value="item" /></el-select></el-form-item>
          </div>
          <div class="form-grid three">
            <el-form-item label="法人"><el-input v-model="form.legal_person" placeholder="可稍后补充" /></el-form-item>
            <el-form-item label="收款性质"><el-input v-model="form.payment_type" placeholder="例如：法人收款" /></el-form-item>
            <el-form-item label="收银机构编码">
              <el-input v-model="form.pos_store_code" placeholder="例如：MD00009" />
              <small class="field-hint">来自收银机「品项销售明细」报表的机构编码，导入时自动回填；一般不用手填。它是导入识别门店的第一优先键，不能与其它门店重复。</small>
            </el-form-item>
          </div>
        </section>
        <section class="form-section"><h4>地址与联系</h4>
          <div class="form-grid three"><el-form-item label="省"><el-input v-model="form.province" placeholder="广东省" /></el-form-item><el-form-item label="市"><el-input v-model="form.city" placeholder="深圳市" /></el-form-item><el-form-item label="区 / 县"><el-input v-model="form.district" placeholder="龙岗区" /></el-form-item></div>
          <el-form-item label="详细地址"><el-input v-model="form.address" placeholder="填写街道、商场或门牌号" /></el-form-item>
          <div class="form-grid two"><el-form-item label="联系电话"><el-input v-model="form.phone" placeholder="门店电话或负责人电话" /></el-form-item><el-form-item label="营业时间"><el-input v-model="form.business_hours" placeholder="例如：10:00 - 22:00" /></el-form-item></div>
        </section>
        <section class="form-section optional-section"><div class="section-title-row"><h4>扩展资料</h4><span>可选</span></div>
          <div class="form-grid three"><el-form-item label="开业日期"><el-date-picker v-model="form.opening_date" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item><el-form-item label="门店面积（㎡）"><el-input v-model="form.store_size" placeholder="例如：120" /></el-form-item><el-form-item label="二人桌数量"><el-input-number v-model="form.table_2person" :min="0" :max="999" controls-position="right" /></el-form-item></div>
          <div class="form-grid three"><el-form-item label="四人桌数量"><el-input-number v-model="form.table_4person" :min="0" :max="999" controls-position="right" /></el-form-item><el-form-item label="纬度（lat）"><el-input v-model="form.lat" placeholder="22.5431" /></el-form-item><el-form-item label="经度（lng）"><el-input v-model="form.lng" placeholder="114.0579" /></el-form-item></div>
          <el-button plain :loading="geocoding" @click="fetchLatLng">根据地址获取经纬度</el-button>
        </section>
      </el-form>
      <template #footer><el-button @click="formVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveStore">{{ creating ? '创建门店' : '保存修改' }}</el-button></template>
    </el-dialog>

    <!-- ===== 闭店 / 发起迁址（共用员工处置表） ===== -->
    <!-- 弹窗内容较长（迁址时有新店资料 + 员工处置表），必须让正文可滚动：
         否则内容超出视口时底部内容（尤其是员工表的后几行）会被裁掉、够不到。 -->
    <el-dialog v-model="closeVisible" :title="closeMode === 'relocate' ? `发起迁址 · ${closingStore?.store_name || ''}` : `闭店 · ${closingStore?.store_name || ''}`" width="min(960px, calc(100vw - 32px))" top="5vh" destroy-on-close class="close-dialog">
      <el-alert v-if="closeMode === 'relocate'" type="warning" :closable="false" show-icon class="mb"
        title="迁址 = 老店闭店 + 新建门店 + 双向关联"
        description="老店按「已闭店(迁址)」结束并移入闭店门店分组；新店单独建档、只记自己的数据。两家店的履历会自动互相指向，便于日后查证。收银机构编码请填新店的编码。" />
      <div class="dialog-scroll">
      <el-form label-position="top">
        <div class="form-grid two">
          <el-form-item :label="closeMode === 'relocate' ? '老店最后营业日' : '闭店日期'" required>
            <el-date-picker v-model="closeForm.closed_date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" />
          </el-form-item>
          <el-form-item label="闭店类型" required>
            <el-select v-model="closeForm.closed_type" :disabled="closeMode === 'relocate'" style="width:100%">
              <el-option v-for="item in closeTypeOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="原因说明"><el-input v-model="closeForm.closed_reason" type="textarea" :rows="2" placeholder="例如：租约到期房东不续 / 商场整体改造" /></el-form-item>
        <el-form-item label="凭证（闭店通知、租约、迁址协议；PDF 或图片，≤10MB）">
          <el-upload :show-file-list="false" :http-request="uploadAttachment" accept="application/pdf,image/*">
            <el-button plain :loading="uploading">{{ closeForm.attachment_url ? '重新上传' : '上传凭证' }}</el-button>
          </el-upload>
          <span v-if="closeForm.attachment_url" class="attachment-chip">
            <a :href="closeForm.attachment_url" target="_blank" rel="noopener">{{ closeForm.attachment_name || '已上传' }}</a>
            <el-button link type="danger" size="small" @click="closeForm.attachment_url = ''; closeForm.attachment_name = ''">移除</el-button>
          </span>
        </el-form-item>

        <template v-if="closeMode === 'relocate'">
          <div class="section-h4"><h4>新门店资料</h4><span class="hint">默认继承老店的店型 / 法人 / 收款性质 / 区域归属，可自行调整</span></div>
          <div class="form-grid three">
            <el-form-item label="新门店名称" required><el-input v-model="newStore.store_name" placeholder="例如：鹅太公烧鹅（龙岗大运店）" /></el-form-item>
            <el-form-item label="状态"><el-select v-model="newStore.status"><el-option label="筹建中" value="筹建中" /><el-option label="正常营业" value="正常营业" /></el-select></el-form-item>
            <el-form-item label="收银机构编码">
              <el-input v-model="newStore.pos_store_code" placeholder="新址在收银系统的机构编码" />
              <small class="field-hint">
                <template v-if="closingStore?.pos_store_code">老店编码为 <b>{{ closingStore.pos_store_code }}</b>；新址在收银系统通常会有<b>新的</b>机构编码，请填新的（不能与老店重复）。</template>
                <template v-else>老店尚未绑定机构编码。可在收银机导出的「品项销售明细」里查看「机构编码」列。</template>
              </small>
            </el-form-item>
          </div>
          <div class="form-grid three"><el-form-item label="省"><el-input v-model="newStore.province" /></el-form-item><el-form-item label="市"><el-input v-model="newStore.city" /></el-form-item><el-form-item label="区 / 县"><el-input v-model="newStore.district" /></el-form-item></div>
          <el-form-item label="详细地址"><el-input v-model="newStore.address" placeholder="新址的门牌号" /></el-form-item>
          <div class="form-grid three">
            <el-form-item label="开业日期"><el-date-picker v-model="newStore.opening_date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" /></el-form-item>
            <el-form-item label="联系电话"><el-input v-model="newStore.phone" /></el-form-item>
            <el-form-item label="门店面积（㎡）"><el-input v-model="newStore.store_size" /></el-form-item>
          </div>
        </template>

        <div class="section-h4">
          <h4>员工处置（必须全部处置才能提交）</h4>
          <span class="hint">{{ closingEmployees.length }} 名在职员工</span>
        </div>
        <el-empty v-if="!closingEmployees.length" description="该门店没有在职员工，无需处置" :image-size="60" />
        <template v-else>
          <!-- 批量设置：先勾选（支持全选），再统一套用去向，避免 9 个人逐个点下拉 -->
          <div class="emp-batch">
            <span class="batch-count">已选 <b>{{ selectedEmpIds.length }}</b> / {{ closingEmployees.length }} 人</span>
            <el-button size="small" text type="primary" @click="selectAllEmps">全选</el-button>
            <el-button size="small" text @click="clearEmpSelection" :disabled="!selectedEmpIds.length">清空选择</el-button>
            <div class="batch-apply">
              <el-select v-model="batchAction" size="small" style="width:132px">
                <el-option v-if="closeMode === 'relocate'" label="随迁到新店" value="transfer_new" />
                <el-option label="调往其他门店" value="transfer" />
                <el-option label="离职" value="resign" />
              </el-select>
              <el-select v-if="batchAction === 'transfer'" v-model="batchTargetStoreId" size="small" filterable placeholder="选择目标门店" style="width:200px">
                <el-option v-for="s in targetStoreOptions" :key="s.id" :label="`${s.store_name}（${s.status}）`" :value="s.id" />
              </el-select>
              <el-button size="small" type="primary" plain :disabled="!selectedEmpIds.length" @click="applyBatch">应用到选中</el-button>
            </div>
          </div>
          <el-table ref="empTableRef" :data="closingEmployees" size="small" class="emp-table" max-height="300" @selection-change="onEmpSelectionChange">
            <el-table-column type="selection" width="44" />
            <el-table-column prop="name" label="姓名" width="94" />
            <el-table-column prop="position" label="岗位" width="110" show-overflow-tooltip />
            <el-table-column label="去向" min-width="180">
              <template #default="{ row }">
                <el-select v-model="empActions[row.id].action" size="small" style="width:100%">
                  <el-option v-if="closeMode === 'relocate'" label="随迁到新店" value="transfer_new" />
                  <el-option label="调往其他门店" value="transfer" />
                  <el-option label="离职" value="resign" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="目标门店" min-width="190">
              <template #default="{ row }">
                <el-select v-if="empActions[row.id].action === 'transfer'" v-model="empActions[row.id].target_store_id" size="small" filterable placeholder="选择去向门店" style="width:100%">
                  <el-option v-for="s in targetStoreOptions" :key="s.id" :label="`${s.store_name}（${s.status}）`" :value="s.id" />
                </el-select>
                <span v-else-if="empActions[row.id].action === 'transfer_new'" class="muted">→ {{ newStore.store_name || '新门店（待填名称）' }}</span>
                <span v-else class="muted">离职日期取闭店日期</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-form>
      </div>
      <template #footer>
        <el-button @click="closeVisible = false">取消</el-button>
        <el-button type="primary" :loading="closing" @click="submitClose">{{ closeMode === 'relocate' ? '确认迁址' : '确认闭店' }}</el-button>
      </template>
    </el-dialog>

    <!-- ===== 重开 ===== -->
    <el-dialog v-model="reopenVisible" :title="`重开 · ${closingStore?.store_name || ''}`" width="min(520px, calc(100vw - 32px))" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon class="mb" title="重开会把门店状态改回「正常营业」，并尽量恢复闭店前的区域归属。" description="已处置走的员工不会自动回来 —— 若有人回来上班，需要重新办理入职或调岗。" />
      <el-form label-position="top">
        <el-form-item label="重开日期"><el-date-picker v-model="reopenForm.reopen_date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="reopenForm.note" type="textarea" :rows="2" placeholder="例如：原址重开 / 换址重开" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="reopenVisible = false">取消</el-button><el-button type="primary" :loading="closing" @click="submitReopen">确认重开</el-button></template>
    </el-dialog>

    <!-- ===== 门店履历 ===== -->
    <el-drawer v-model="lifecycleVisible" :title="`门店履历 · ${lifecycleStore?.store_name || ''}`" size="min(680px, 96vw)" destroy-on-close>
      <div v-loading="lifecycleLoading" class="lifecycle-body">
        <section class="lifecycle-head">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="当前状态">{{ lifecycle.store?.status || '—' }}</el-descriptions-item>
            <el-descriptions-item label="所属分组">{{ lifecycle.region?.name || '未分组' }}</el-descriptions-item>
            <el-descriptions-item label="开业日期">{{ lifecycle.store?.opening_date || '—' }}</el-descriptions-item>
            <el-descriptions-item label="闭店">{{ lifecycle.store?.closed_date ? `${lifecycle.store.closed_date}${lifecycle.store.closed_type ? ' · ' + lifecycle.store.closed_type : ''}` : '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="lifecycle.relocated_from || lifecycle.relocated_to" class="relink">
            <b>迁址关联：</b>
            <template v-if="lifecycle.relocated_from">
              由 <el-button link type="primary" @click="openLifecycleById(lifecycle.relocated_from.id)">{{ lifecycle.relocated_from.store_name }}</el-button>
              （{{ lifecycle.relocated_from.closed_date || '—' }} 闭店）迁址而来
            </template>
            <template v-if="lifecycle.relocated_to">
              迁往 <el-button link type="primary" @click="openLifecycleById(lifecycle.relocated_to.id)">{{ lifecycle.relocated_to.store_name }}</el-button>
            </template>
          </div>
        </section>
        <el-timeline v-if="lifecycle.events?.length" class="timeline">
          <el-timeline-item v-for="ev in lifecycle.events" :key="ev.id" :timestamp="ev.event_date" placement="top" :type="eventTone(ev.event_type)">
            <div class="ev">
              <b>{{ ev.event_type }}</b>
              <span v-if="ev.old_value || ev.new_value" class="ev-change">{{ ev.old_value || '—' }} → {{ ev.new_value || '—' }}</span>
              <p v-if="ev.note">{{ ev.note }}</p>
              <p v-if="ev.details?.from_store_name || ev.details?.to_store_name || ev.details?.previous_region_name" class="ev-detail">
                <span v-if="ev.details.previous_region_name">原区域：{{ ev.details.previous_region_name }}</span>
                <span v-if="ev.details.to_store_name">迁往：{{ ev.details.to_store_name }}</span>
                <span v-if="ev.details.from_store_name">来自：{{ ev.details.from_store_name }}</span>
              </p>
              <a v-if="ev.attachment_url" :href="ev.attachment_url" target="_blank" rel="noopener" class="ev-attach">📎 {{ ev.attachment_name || '凭证' }}</a>
              <small class="ev-meta">{{ ev.source }}</small>
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无履历记录（此门店建立于本功能上线之前）" :image-size="80" />
      </div>
    </el-drawer>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import {
  createStore, geocodeAddress, getStoreById, getStoreStats, getStores, updateStore,
  getStoreLifecycle, getStoreLifecycleMeta, closeStore, relocateStore, reopenStore,
} from '@/api'

const FALLBACK_STATUSES = ['筹建中', '正常营业', '已闭店']
const CLOSED_ALIASES = ['已闭店', '闭店', '迁址']
const isClosed = (store) => CLOSED_ALIASES.includes(String(store?.status || '').trim())

const statusOptions = ref([...FALLBACK_STATUSES])
// 通用编辑弹窗里不提供「已闭店」：闭店必须走专用流程（校验员工处置 + 写履历 + 移入闭店分组）
const formStatusOptions = computed(() => statusOptions.value.filter(s => !CLOSED_ALIASES.includes(s)))
const typeOptions = ['直营店', '加盟店', '联营店']
const meta = ref({ closed_types: ['迁址', '租约到期', '经营不善', '商场物业调整', '其他'] })
// 闭店弹窗里排除「迁址」—— 迁址有专门的「发起迁址」流程（要同时建新店并双向关联）
const closeTypeOptions = computed(() => (meta.value.closed_types || []).filter(t => t !== '迁址'))

const makeForm = () => ({ store_name: '', status: '筹建中', store_type: '直营店', legal_person: '', payment_type: '法人收款', pos_store_code: '', region: '', province: '', city: '', district: '', address: '', phone: '', business_hours: '', opening_date: null, table_2person: 0, table_4person: 0, store_size: '', lat: '', lng: '' })

const stats = ref({})
const stores = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const keyword = ref('')
const status = ref('')
const storeType = ref('')
const legalPerson = ref('')
const formVisible = ref(false)
const creating = ref(true)
const saving = ref(false)
const geocoding = ref(false)
const uploading = ref(false)
const closing = ref(false)
const form = reactive(makeForm())
const joinedStoreCount = computed(() => Number(stats.value.joint_count || 0) + Number(stats.value.franchise_count || 0))

// 闭店 / 迁址 / 重开 / 履历
const closingStore = ref(null)
const closeVisible = ref(false)
const closeMode = ref('close')
const closingEmployees = ref([])
const empActions = reactive({})
const targetStoreOptions = ref([])
// 批量处置：勾选（支持全选）后统一套用去向，避免十几个人逐个点下拉
const empTableRef = ref(null)
const selectedEmpIds = ref([])
const batchAction = ref('transfer_new')
const batchTargetStoreId = ref(null)
const closeForm = reactive({ closed_date: '', closed_type: '', closed_reason: '', attachment_url: '', attachment_name: '' })
const newStore = reactive({ store_name: '', status: '筹建中', pos_store_code: '', province: '', city: '', district: '', address: '', phone: '', opening_date: null, store_size: '' })
const reopenVisible = ref(false)
const reopenForm = reactive({ reopen_date: '', note: '' })
const lifecycleVisible = ref(false)
const lifecycleLoading = ref(false)
const lifecycleStore = ref(null)
const lifecycle = ref({})

function resetForm(values = {}) { Object.assign(form, makeForm(), values) }
function statusTag(value) { return ({ '正常营业': 'success', '筹建中': 'warning', '已闭店': 'info', '闭店': 'info', '迁址': 'warning' })[value] || '' }
function rowClass({ row }) { return isClosed(row) ? 'row-closed' : '' }
function eventTone(type) {
  if (type === '闭店' || type === '迁址迁出') return 'danger'
  if (type === '开业' || type === '重开' || type === '迁址迁入') return 'success'
  if (type === '更名' || type === '法人变更' || type === '店型变更') return 'warning'
  return 'primary'
}
function openCreate() { creating.value = true; resetForm(); formVisible.value = true }
async function openEdit(store) {
  try { const data = await getStoreById(store.id); creating.value = false; resetForm(data.store || {}); formVisible.value = true }
  catch (error) { ElMessage.error(error.message || '加载门店信息失败') }
}

async function loadStats() { try { const data = await getStoreStats(); stats.value = data.stats || {} } catch {} }
async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (keyword.value) params.keyword = keyword.value
    if (status.value) params.status = status.value
    if (storeType.value) params.store_type = storeType.value
    if (legalPerson.value) params.legal_person = legalPerson.value
    const data = await getStores(params)
    stores.value = data.stores || []
    total.value = data.total || 0
  } catch (error) { ElMessage.error(`加载失败：${error.message}`) } finally { loading.value = false }
}
function search() { page.value = 1; loadData() }
function resetFilters() { keyword.value = ''; status.value = ''; storeType.value = ''; legalPerson.value = ''; search() }

async function fetchLatLng() {
  const address = [form.province, form.city, form.district, form.address].filter(Boolean).join('')
  if (!address) return ElMessage.warning('请先填写省、市、区或详细地址')
  geocoding.value = true
  try {
    const data = await geocodeAddress({ address })
    if (data.status !== '1' || !data.geocodes?.length) throw new Error(data.info || '未找到该地址')
    const [lng, lat] = data.geocodes[0].location.split(',')
    form.lng = lng; form.lat = lat
    ElMessage.success('已获取经纬度')
  } catch (error) { ElMessage.warning(`获取失败：${error.message || '请手动填写'}`) } finally { geocoding.value = false }
}
async function saveStore() {
  if (!form.store_name.trim()) return ElMessage.warning('请填写门店名称')
  saving.value = true
  try {
    const payload = { ...form, store_name: form.store_name.trim() }
    if (creating.value) { await createStore(payload); page.value = 1; ElMessage.success('门店已创建，可前往“门店区域管理”设置归属') }
    else { await updateStore(form.id, payload); ElMessage.success('门店资料已保存') }
    formVisible.value = false
    await Promise.all([loadData(), loadStats()])
  } catch (error) { ElMessage.error(`保存失败：${error.message}`) } finally { saving.value = false }
}

// ===== 闭店 / 迁址 =====
function onAction(cmd, row) {
  if (cmd === 'lifecycle') return openLifecycle(row)
  if (cmd === 'close') return openClose(row, 'close')
  if (cmd === 'relocate') return openClose(row, 'relocate')
  if (cmd === 'reopen') return openReopen(row)
}
// 目标门店候选：**包含筹建中门店**（迁址新店常见状态就是筹建中，若只列「正常营业」会选不到），
// 只排除已闭店门店与自身。
async function loadTargetStores(excludeId) {
  try {
    const data = await getStores({ page_size: 500 })
    targetStoreOptions.value = (data.stores || [])
      .filter(s => Number(s.id) !== Number(excludeId) && !isClosed(s))
  } catch { targetStoreOptions.value = [] }
}
function onEmpSelectionChange(rows) { selectedEmpIds.value = rows.map(r => Number(r.id)) }
function selectAllEmps() { empTableRef.value?.toggleAllSelection() }
function clearEmpSelection() { empTableRef.value?.clearSelection(); selectedEmpIds.value = [] }
/** 把批量栏里的去向一次性套用到选中员工 */
function applyBatch() {
  const ids = selectedEmpIds.value
  if (!ids.length) return ElMessage.warning('请先勾选员工（可点「全选」）')
  if (batchAction.value === 'transfer' && !batchTargetStoreId.value) return ElMessage.warning('请先选择目标门店')
  ids.forEach(id => {
    if (!empActions[id]) empActions[id] = { action: 'resign', target_store_id: null }
    empActions[id].action = batchAction.value
    empActions[id].target_store_id = batchAction.value === 'transfer' ? batchTargetStoreId.value : null
  })
  ElMessage.success(`已把 ${ids.length} 人设为「${{ transfer_new: '随迁到新店', transfer: '调往其他门店', resign: '离职' }[batchAction.value]}」`)
}
async function openClose(store, mode) {
  closingStore.value = store
  closeMode.value = mode
  Object.assign(closeForm, { closed_date: '', closed_type: mode === 'relocate' ? '迁址' : '', closed_reason: '', attachment_url: '', attachment_name: '' })
  Object.assign(newStore, { store_name: '', status: '筹建中', pos_store_code: '', province: '', city: '', district: '', address: '', phone: '', opening_date: null, store_size: '' })
  Object.keys(empActions).forEach(k => delete empActions[k])
  selectedEmpIds.value = []
  batchAction.value = mode === 'relocate' ? 'transfer_new' : 'resign'
  batchTargetStoreId.value = null
  closeVisible.value = true
  try {
    const data = await getStoreById(store.id)
    // 只需处置在职员工（离职的人当初就在这家店离职，属历史事实）
    closingEmployees.value = (data.employees || []).filter(e => !e.leave_date)
    closingEmployees.value.forEach(e => { empActions[e.id] = { action: mode === 'relocate' ? 'transfer_new' : 'resign', target_store_id: null } })
  } catch (error) { ElMessage.error('读取门店员工失败：' + error.message); closingEmployees.value = [] }
  await loadTargetStores(store.id)
}
function buildEmployeeActions() {
  return closingEmployees.value.map(e => {
    const a = empActions[e.id] || {}
    if (a.action === 'transfer_new') return { employee_id: e.id, action: 'transfer' }   // 后端默认落到新店
    if (a.action === 'transfer') return { employee_id: e.id, action: 'transfer', target_store_id: a.target_store_id || undefined }
    return { employee_id: e.id, action: 'resign' }
  })
}
function validateBeforeSubmit() {
  if (!closeForm.closed_date) return '请选择日期'
  if (closeMode.value === 'close' && !closeForm.closed_type) return '请选择闭店类型'
  if (closeMode.value === 'relocate' && !newStore.store_name.trim()) return '请填写新门店名称'
  for (const e of closingEmployees.value) {
    const a = empActions[e.id] || {}
    if (a.action === 'transfer' && !a.target_store_id) return `员工「${e.name}」选择调往其他门店，但还没选目标门店`
  }
  return ''
}
async function uploadAttachment({ file }) {
  uploading.value = true
  try {
    const token = localStorage.getItem('etaigong_token')
    const res = await fetch('/api/store-attachments', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || '门店凭证'), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: file,
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '上传失败')
    closeForm.attachment_url = data.url; closeForm.attachment_name = data.name
    ElMessage.success('凭证已上传')
  } catch (error) { ElMessage.error('凭证上传失败：' + error.message) } finally { uploading.value = false }
}
async function submitClose() {
  const invalid = validateBeforeSubmit()
  if (invalid) return ElMessage.warning(invalid)
  const payload = {
    closed_date: closeForm.closed_date,
    closed_reason: closeForm.closed_reason,
    attachment_url: closeForm.attachment_url, attachment_name: closeForm.attachment_name,
    employee_actions: buildEmployeeActions(),
  }
  closing.value = true
  try {
    if (closeMode.value === 'relocate') {
      payload.new_store = { ...newStore, store_name: newStore.store_name.trim() }
      const data = await relocateStore(closingStore.value.id, payload)
      ElMessage.success(`已迁址：${data.old_store_name} → ${data.new_store_name}（新店已建档，请在「门店区域管理」确认归属）`)
    } else {
      payload.closed_type = closeForm.closed_type
      await closeStore(closingStore.value.id, payload)
      ElMessage.success('已完成闭店，门店已移入「闭店门店」分组')
    }
    closeVisible.value = false
    await Promise.all([loadData(), loadStats()])
  } catch (error) {
    const pending = error?.pending_employees
    ElMessage.error(error.message + (pending?.length ? `（待处置：${pending.map(p => p.name).join('、')}）` : ''))
  } finally { closing.value = false }
}
function openReopen(store) {
  closingStore.value = store
  Object.assign(reopenForm, { reopen_date: '', note: '' })
  reopenVisible.value = true
}
async function submitReopen() {
  closing.value = true
  try {
    const data = await reopenStore(closingStore.value.id, { ...reopenForm })
    ElMessage.success(data.region_restored ? '已重开，并恢复原区域归属' : '已重开（未找到原区域记录，请在区域管理中指定归属）')
    reopenVisible.value = false
    await Promise.all([loadData(), loadStats()])
  } catch (error) { ElMessage.error('重开失败：' + error.message) } finally { closing.value = false }
}

// ===== 履历 =====
async function openLifecycle(store) { lifecycleStore.value = store; lifecycleVisible.value = true; await loadLifecycle(store.id) }
async function openLifecycleById(id) {
  try { const data = await getStoreById(id); lifecycleStore.value = data.store; await loadLifecycle(id) }
  catch (error) { ElMessage.error('打开关联门店失败：' + error.message) }
}
async function loadLifecycle(id) {
  lifecycleLoading.value = true
  try { const data = await getStoreLifecycle(id); lifecycle.value = { store: data.store, region: data.region, events: data.events, relocated_from: data.relocated_from, relocated_to: data.relocated_to } }
  catch (error) { ElMessage.error('读取门店履历失败：' + error.message); lifecycle.value = {} } finally { lifecycleLoading.value = false }
}

onMounted(async () => {
  try { const m = await getStoreLifecycleMeta(); meta.value = m; if (m.statuses?.length) statusOptions.value = m.statuses } catch {}
  loadStats(); loadData()
})
</script>

<style scoped>
.store-basic-page { max-width: 1480px; margin: 0 auto; }
.page-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:26px 30px; border-radius:16px; background:linear-gradient(118deg,#13396d,#2674c9 62%,#4aa6e8); color:#fff; box-shadow:0 10px 24px rgba(24,72,135,.18); }
.eyebrow,.section-kicker { display:block; font-size:11px; font-weight:800; letter-spacing:1.5px; }
.eyebrow { color:#b9dcff; }
.page-hero h2 { margin:7px 0; font-size:26px; }
.page-hero p { margin:0; color:#d7ebff; font-size:13px; }
.create-store-button { min-width:132px; border-color:#fff; font-weight:700; }
.stats-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:14px; margin:16px 0; }
.stat-card { min-height:104px; padding:18px 19px; border:1px solid #e3eaf3; border-radius:12px; background:#fff; box-shadow:0 5px 15px rgba(31,62,106,.04); }
.stat-card span,.stat-card small { display:block; color:#8492a6; font-size:12px; }
.stat-card b { display:block; margin:8px 0 5px; color:#253f66; font-size:27px; line-height:1; }
.stat-card.positive b { color:#14a06f; }
.stat-card.warning b { color:#e2932e; }
.stat-card.violet b { color:#7865d6; }
.stat-card.info-card b { color:#6b7c93; }
.stats-note { margin:-4px 0 14px; color:#7d8b9e; font-size:12px; }
.directory-card { padding:21px; border:1px solid #e1e8f1; border-radius:13px; background:#fff; box-shadow:0 8px 22px rgba(31,62,106,.05); }
.directory-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding-bottom:17px; border-bottom:1px solid #e8edf4; }
.section-kicker { color:#5b86ce; }
.directory-header h3 { margin:5px 0; color:#273f62; font-size:20px; }
.directory-header p { margin:0; color:#8b99aa; font-size:12px; }
.filters { display:grid; grid-template-columns:minmax(190px,1.35fr) minmax(130px,.75fr) minmax(130px,.75fr) minmax(160px,1fr) auto; gap:11px; padding:17px 0; }
.store-table { width:100%; overflow:hidden; border:1px solid #e4eaf2; border-radius:8px; }
.store-table :deep(.row-closed) { background:#f7f8fa; }
.store-table :deep(.row-closed td) { color:#93a0b2; }
.name-closed { color:#8b98aa; }
.mini-tag { margin-left:6px; }
.store-cell { display:flex; flex-direction:column; gap:2px; line-height:1.35; }
.code-line { color:#8493a6; font-size:11px; font-family:ui-monospace,Consolas,monospace; }
.code-missing { color:#c98a1f; font-family:inherit; }
.pagination { justify-content:flex-end; margin-top:16px; }
.dialog-intro { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
.dialog-intro b { color:#26405f; font-size:15px; }
.dialog-intro span { color:#93a0b3; font-size:12px; }
.dialog-intro em { color:#e2604a; font-style:normal; }
.closed-alert { margin-bottom:14px; }
.store-form .form-section { padding:14px 0; border-top:1px solid #eef2f7; }
.store-form .form-section:first-child { border-top:0; padding-top:0; }
.store-form h4 { margin:0 0 12px; color:#2c476a; font-size:14px; }
.section-title-row { display:flex; align-items:baseline; justify-content:space-between; }
.section-title-row span { color:#93a0b3; font-size:11px; }
.form-grid { display:grid; gap:14px; }
.form-grid.two { grid-template-columns:repeat(2,minmax(0,1fr)); }
.form-grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }
.field-hint { display:block; margin-top:4px; color:#94a2b4; font-size:11px; line-height:1.5; }
.mb { margin-bottom:14px; }
.section-h4 { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin:18px 0 10px; padding-top:14px; border-top:1px solid #eef2f7; }
.section-h4 h4 { margin:0; color:#2c476a; font-size:14px; }
.section-h4 .hint { color:#94a2b4; font-size:11px; font-weight:400; text-align:right; }
/* 弹窗正文可滚动：迁址时内容很长（新店资料 + 员工处置表），
   不可滚动会把底部内容裁掉 —— 员工表只显示一两行、后面的员工根本够不到。 */
.dialog-scroll { max-height: 62vh; overflow-y: auto; padding-right: 6px; }
.dialog-scroll::-webkit-scrollbar { width: 8px; }
.dialog-scroll::-webkit-scrollbar-thumb { border-radius: 4px; background: #d5dfeb; }
.emp-batch { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px; padding:9px 12px; border:1px solid #e2eaf4; border-radius:9px; background:#f7fafd; }
.batch-count { color:#5d6e87; font-size:12px; }
.batch-count b { color:#2674c9; }
.batch-apply { display:flex; align-items:center; gap:8px; margin-left:auto; }
.emp-table { border:1px solid #e8eef6; border-radius:8px; }
.muted { color:#93a0b3; font-size:12px; }
.attachment-chip { display:inline-flex; align-items:center; gap:8px; margin-left:10px; font-size:12px; }
.lifecycle-body { padding:0 4px; }
.lifecycle-head { margin-bottom:18px; }
.relink { margin-top:12px; padding:10px 12px; border-radius:10px; background:#f5f8fc; color:#4b637f; font-size:12px; line-height:1.9; }
.timeline { padding-left:4px; }
.ev b { color:#2c476a; font-size:13px; }
.ev-change { margin-left:8px; color:#6b7c93; font-size:12px; }
.ev p { margin:5px 0 0; color:#7d8b9e; font-size:12px; line-height:1.6; }
.ev-detail { display:flex; flex-wrap:wrap; gap:12px; }
.ev-attach { display:inline-block; margin-top:6px; font-size:12px; color:#2674c9; }
.ev-meta { display:block; margin-top:4px; color:#a7b2c0; font-size:11px; }
@media (max-width:1200px) { .stats-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:760px) { .stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .filters, .form-grid.two, .form-grid.three { grid-template-columns:1fr; } .page-hero { flex-direction:column; align-items:flex-start; } }
</style>
