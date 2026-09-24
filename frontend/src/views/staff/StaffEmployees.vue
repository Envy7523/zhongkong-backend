<template>
  <div class="staff-employees-page">
    <section class="staff-hero">
      <div>
        <span class="staff-kicker">人事专区</span>
        <h1>员工管理</h1>
        <p>统一维护员工档案、组织归属与钉钉考勤</p>
      </div>
      <div class="staff-hero__actions">
        <el-upload :auto-upload="false" :show-file-list="false" :on-change="onFilePicked" accept=".xlsx,.xls,.csv">
          <el-button :loading="importing">导入表格</el-button>
        </el-upload>
        <el-button :loading="syncing" @click="syncFromSheet">从企微同步</el-button>
        <el-button @click="openDingTalk">钉钉考勤</el-button>
        <el-button type="primary" @click="openCreate">新增员工</el-button>
      </div>
    </section>

    <!-- 统计卡片 -->
    <div class="dash-stat-grid staff-stat-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><UserFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value success">{{ stats.total ?? '—' }}</div>
          <div class="dash-stat-label">员工总数</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><CircleCheckFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value primary">{{ stats.active ?? '—' }}</div>
          <div class="dash-stat-label">在职员工</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#fff0f0;"><el-icon size="22"><CircleCloseFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value danger">{{ stats.inactive ?? '—' }}</div>
          <div class="dash-stat-label">离职员工</div>
        </div>
      </div>
    </div>

    <section class="staff-query-card">
      <header class="staff-query-card__header">
        <div>
          <span class="staff-kicker">员工档案</span>
          <h2>快速查询</h2>
          <p>按人员、在职状态和归属筛选员工档案</p>
        </div>
      </header>
      <div class="staff-affiliation-tabs">
        <span>人员范围</span>
        <el-radio-group v-model="affiliationType" aria-label="员工归属类型" @change="changeAffiliationType">
          <el-radio-button value="">全部人员</el-radio-button>
          <el-radio-button value="store">门店员工</el-radio-button>
          <el-radio-button value="group">集团员工</el-radio-button>
        </el-radio-group>
      </div>
      <div class="staff-filter-grid">
        <el-input v-model="keyword" placeholder="搜索姓名或手机号" clearable />
        <el-select v-model="status" placeholder="在职状态" clearable>
          <el-option label="在职" value="在职" />
          <el-option label="离职" value="离职" />
        </el-select>
        <StoreRegionSelect v-model="filterAffiliation" :stores="stores" show-group placeholder="全部门店 / 集团" @update:model-value="onFilterAffiliationChange" />
        <el-button type="primary" @click="search">查询</el-button>
      </div>
      <p class="staff-query-note">支持导入 Excel / CSV，也可从企业微信智能表格同步员工档案。</p>
    </section>

    <!-- 员工表格（按企业微信智能表格字段维护） -->
    <section class="staff-table-card">
      <header class="staff-table-card__header">
        <div>
          <span class="staff-kicker">员工名册</span>
          <h2>员工列表 <small>共 {{ total }} 人</small></h2>
        </div>
        <div class="staff-table-card__actions">
          <el-tag v-if="selectedStaff.length" type="primary" effect="light">已选 {{ selectedStaff.length }} 人</el-tag>
          <el-button v-if="selectedStaff.length" type="primary" plain @click="openDingTalk">同步选中考勤</el-button>
        </div>
      </header>
      <el-table class="staff-table" :data="list" row-key="id" v-loading="loading" stripe @selection-change="handleStaffSelection">
        <el-table-column type="selection" width="46" fixed="left" :reserve-selection="true" />
        <el-table-column prop="name" label="姓名" min-width="110" fixed="left" />
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column prop="gender" label="性别" width="64" />
        <el-table-column prop="age" label="年龄" width="64"><template #default="{ row }">{{ row.age ?? '—' }}</template></el-table-column>
        <el-table-column prop="store_name" label="归属门店 / 集团" min-width="180" show-overflow-tooltip><template #default="{ row }"><el-tag v-if="GROUP_NAMES.includes(row.store_name)" type="warning" size="small">{{ row.store_name }}</el-tag><span v-else>{{ row.store_name || '未分配' }}</span></template></el-table-column>
        <el-table-column prop="position" label="职位" width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.position || '—' }}</span>
            <el-tooltip v-if="(row.positions || []).length > 1" :content="(row.positions || []).map(item => item.is_primary ? `${item.position}（主岗位）` : item.position).join('、')" placement="top">
              <small class="position-extra">+{{ row.positions.length - 1 }}</small>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="entry_date" label="入职日期" width="112" />
        <el-table-column prop="onboarding_status" label="入职状态" width="90" />
        <el-table-column prop="status" label="在职状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === '在职' ? 'success' : 'info'" size="small">{{ row.status || '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <div class="staff-row-actions"><el-button size="small" @click="openEdit(row)">编辑</el-button><el-button size="small" link type="primary" @click="openLifecycle(row)">生命线</el-button><el-button size="small" link type="success" @click="openAttendance(row)">考勤</el-button></div>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        style="margin-top:16px;justify-content:flex-end;"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="loadData"
      />
    </section>

    <el-dialog v-model="editVisible" :title="(editingId ? '编辑员工 · ' : '新增员工 · ') + (editForm.name || '未命名')" width="820px" class="staff-profile-dialog">
      <header class="current-level-heading" :class="`current-${profileLevel.toLowerCase()}`">
        <span>{{ profileLevel }}</span><div><b>{{ profileMeta[profileLevel].title }}</b><small>{{ profileMeta[profileLevel].description }}</small></div>
      </header>
      <el-tabs v-model="profileLevel" class="profile-level-tabs" stretch>
        <el-tab-pane name="A"><template #label><span class="level-label level-a"><b>1</b><span>基础信息<small>员工识别与联系</small></span></span></template>
          <section class="profile-section"><el-form label-position="top"><div class="identity-row"><div class="personal-photo"><span>个人照片</span><PhotoThumb :src="editForm.photo_url" hint="个人照片" @picked="file => handlePhotoPick(file, 'photo_url')" /><el-button v-if="editForm.photo_url" link type="danger" size="small" @click="clearPhoto('photo_url')">移除</el-button></div><div class="identity-row__fields">
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="姓名" required><el-input v-model="editForm.name" /></el-form-item></el-col><el-col :span="12"><el-form-item label="手机号" :error="phoneError"><el-input v-model="editForm.phone" @input="validateFields" placeholder="11 位中国大陆手机号" /></el-form-item></el-col></el-row>
            <el-form-item label="钉钉员工 ID"><el-input v-model="editForm.dingtalk_user_id" placeholder="用于自动匹配钉钉打卡记录" clearable /></el-form-item>
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="性别"><el-select v-model="editForm.gender" style="width:100%"><el-option label="男" value="男" /><el-option label="女" value="女" /></el-select></el-form-item></el-col><el-col :span="12"><el-form-item label="年龄"><el-input v-model="editForm.age" readonly placeholder="身份证识别" /></el-form-item></el-col></el-row>
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="紧急联系人"><el-input v-model="editForm.emergency_contact" /></el-form-item></el-col><el-col :span="12"><el-form-item label="紧急联系电话"><el-input v-model="editForm.emergency_phone" /></el-form-item></el-col></el-row>
          </div></div></el-form></section>
        </el-tab-pane>
        <el-tab-pane name="B"><template #label><span class="level-label level-b"><b>2</b><span>详细信息<small>证件、联系与合规资料</small></span></span></template>
          <section class="profile-section"><el-form label-position="top"><el-row :gutter="16"><el-col :span="16"><el-form-item label="身份证号码" :error="idCardError"><el-input v-model="editForm.id_card_number" @input="onIdCardInput" placeholder="填写后自动计算年龄并校验" /></el-form-item></el-col><el-col :span="8"><el-form-item label="已识别年龄"><el-input v-model="editForm.age" readonly /></el-form-item></el-col></el-row>
            <div class="idcard-verify"><div class="idcard-verify__bar"><el-button size="small" :loading="ocrState.loading" :disabled="!canRunIdCardScan" @click="runIdCardScan">身份证识别核对</el-button><el-checkbox v-if="!requireIdVerification" v-model="idVerifyWaived" size="small">人工核对通过，跳过机器核对</el-checkbox></div><el-alert v-if="ocrState.status && ocrState.status !== 'pass'" :type="ocrState.status === 'mismatch' ? 'error' : (ocrState.status === 'error' ? 'error' : 'warning')" :closable="false" show-icon class="idcard-verify__alert"><template #title>{{ ocrState.message }}</template><template #default><small v-if="ocrState.scanned">识别到：姓名 {{ ocrState.scanned.name_masked || '未识别' }}｜号码 {{ ocrState.scanned.id_card_masked || '未识别' }}<span v-if="ocrState.scanned.checksum_ok === false">（校验位不正确）</span><br />档案为：姓名 {{ ocrState.expected?.name_masked || '未填' }}｜号码 {{ ocrState.expected?.id_card_masked || '未填' }}</small></template></el-alert><el-alert v-else-if="ocrState.status === 'pass'" type="success" :closable="false" show-icon class="idcard-verify__alert" title="识别结果与当前员工档案一致（姓名与号码均一致）" /><small v-else-if="!canRunIdCardScan" class="idcard-verify__hint">{{ idCardScanHint }}</small></div>
            <el-row :gutter="16"><el-col :span="8"><el-form-item label="身份证正面照片"><div class="photo-upload"><PhotoThumb :src="editForm.id_card_front_url" hint="身份证正面" @picked="file => handlePhotoPick(file, 'id_card_front_url')" /><el-button v-if="editForm.id_card_front_url" link type="danger" size="small" @click="clearPhoto('id_card_front_url')">移除</el-button></div></el-form-item></el-col><el-col :span="8"><el-form-item label="身份证反面照片"><div class="photo-upload"><PhotoThumb :src="editForm.id_card_back_url" hint="身份证反面" @picked="file => handlePhotoPick(file, 'id_card_back_url')" /><el-button v-if="editForm.id_card_back_url" link type="danger" size="small" @click="clearPhoto('id_card_back_url')">移除</el-button></div></el-form-item></el-col><el-col :span="8"><el-form-item label="健康证照片"><div class="photo-upload"><PhotoThumb :src="editForm.health_certificate_url" hint="健康证" @picked="file => handlePhotoPick(file, 'health_certificate_url')" /><el-button v-if="editForm.health_certificate_url" link type="danger" size="small" @click="clearPhoto('health_certificate_url')">移除</el-button></div></el-form-item></el-col></el-row>
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="健康证失效时间"><el-date-picker v-model="editForm.health_certificate_expiry" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /></el-form-item></el-col><el-col v-if="isGroupEmployee" :span="12"><el-form-item label="劳动关系隶属"><el-input v-model="editForm.labor_relation" placeholder="如：集团主体" /></el-form-item></el-col></el-row>
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="籍贯"><el-input v-model="editForm.native_place" placeholder="省 / 市 / 区县" /></el-form-item></el-col><el-col :span="12"><el-form-item label="户籍"><el-input v-model="editForm.household_registration" placeholder="户籍所在地" /></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="户口性质"><el-select v-model="editForm.household_type" clearable placeholder="请选择" style="width:100%"><el-option label="城镇" value="城镇" /><el-option label="农村" value="农村" /></el-select></el-form-item></el-col><el-col :span="12"><el-form-item label="联系地址"><el-input v-model="editForm.contact_address" /></el-form-item></el-col></el-row>
            <el-row :gutter="16"><el-col :span="12"><el-form-item label="合同起始"><el-date-picker v-model="editForm.contract_start_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /></el-form-item></el-col><el-col :span="12"><el-form-item label="合同截止"><el-date-picker v-model="editForm.contract_end_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /></el-form-item></el-col></el-row><el-form-item label="社保参保编号"><el-input v-model="editForm.social_security_number" /></el-form-item>
            <template v-if="isGroupEmployee"><div class="form-divider">集团员工教育信息</div><el-row :gutter="16"><el-col :span="12"><el-form-item label="毕业院校"><el-input v-model="editForm.education_school" /></el-form-item></el-col><el-col :span="12"><el-form-item label="学历"><el-select v-model="editForm.education_level" clearable placeholder="请选择" style="width:100%"><el-option v-for="item in educationOptions" :key="item" :label="item" :value="item" /></el-select></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="毕业时间"><el-date-picker v-model="editForm.graduation_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /></el-form-item></el-col><el-col :span="12"><el-form-item label="专业"><el-input v-model="editForm.major" /></el-form-item></el-col></el-row></template><el-form-item label="备注"><el-input v-model="editForm.remark" type="textarea" :rows="2" /></el-form-item>
          </el-form></section>
        </el-tab-pane>
        <el-tab-pane name="C"><template #label><span class="level-label level-c"><b>3</b><span>人员调整<small>集团内任用与状态调整</small></span></span></template>
          <section class="profile-section personnel-section"><el-alert title="调整归属、岗位、职级、离职、健康证或工资时需要说明原因；岗位、转正和离职变更需上传对应材料。" type="info" :closable="false" show-icon style="margin-bottom:16px" /><div class="change-attachment"><div><b>调整材料</b><small>岗位、转正时间、离职时间各自独立留档；变更对应字段时必须上传其材料。</small></div></div><el-form label-position="top"><el-row :gutter="16"><el-col :span="8"><el-form-item label="归属门店 / 集团" required><StoreRegionSelect v-model="editAffiliation" :stores="stores" show-group :clearable="false" placeholder="选择后台门店或集团" /></el-form-item></el-col><el-col :span="16"><el-form-item label="岗位（最多 5 个，选一个为主岗位）">
              <div class="multi-position">
              <div v-for="(row, index) in editPositions" :key="index" class="multi-position__row">
              <el-input v-if="isGroupEmployee" v-model="row.position" placeholder="填写集团岗位" />
              <el-select v-else v-model="row.position" filterable clearable placeholder="请选择岗位" style="width:100%"><el-option v-for="item in storePositionOptions" :key="item" :label="item" :value="item" /></el-select>
              <el-radio v-model="primaryPositionIndex" :label="index" class="multi-position__primary" @change="markPrimary(index)">主岗位</el-radio>
              <el-button link type="danger" :disabled="editPositions.length <= 1" @click="removePosition(index)">删除</el-button>
              </div>
              <div class="multi-position__actions">
              <el-button link type="primary" :disabled="editPositions.length >= positionLimit" @click="addPosition">{{ editPositions.length >= positionLimit ? `已达上限 ${positionLimit} 个岗位` : '+ 新增岗位' }}</el-button>
              <small>列表「职位」列与工资表、人效均取主岗位。</small>
              </div>
              </div>
              <div class="field-attachment"><el-upload :auto-upload="false" :show-file-list="false" accept="image/*,.pdf,application/pdf" :on-change="file => onChangeAttachmentPicked(file, 'position')"><el-button link type="primary" :loading="attachmentUploading === 'position'">{{ changeAttachments.position.name ? '已附岗位材料' : '上传岗位材料' }}</el-button></el-upload><span v-if="changeAttachments.position.url" class="field-attachment__name">{{ changeAttachments.position.name || '已上传材料' }}</span></div>
              </el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="8"><el-form-item label="职级"><el-input v-model="editForm.job_level" placeholder="如：初级 / P3" /></el-form-item></el-col><el-col :span="8"><el-form-item label="在职状态"><el-input :model-value="derivedEmploymentStatus" readonly /></el-form-item></el-col><el-col :span="8"><el-form-item label="入职状态"><el-input :model-value="derivedOnboardingStatus" readonly /></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="入职日期"><el-date-picker v-model="editForm.entry_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /></el-form-item></el-col><el-col :span="12"><el-form-item label="用工类型"><el-select v-model="editForm.hire_type" style="width:100%"><el-option label="全职" value="全职" /><el-option label="兼职" value="兼职" /></el-select></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="转正时间"><el-date-picker v-model="editForm.probation_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /><div class="field-attachment"><el-upload :auto-upload="false" :show-file-list="false" accept="image/*,.pdf,application/pdf" :on-change="file => onChangeAttachmentPicked(file, 'probation_date')"><el-button link type="primary" :loading="attachmentUploading === 'probation_date'">{{ changeAttachments.probation_date.name ? '已附转正材料' : '上传转正材料' }}</el-button></el-upload><span v-if="changeAttachments.probation_date.url" class="field-attachment__name">{{ changeAttachments.probation_date.name || '已上传材料' }}</span></div></el-form-item></el-col><el-col :span="12"><el-form-item label="离职时间"><el-date-picker v-model="editForm.leave_date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%" clearable /><div class="field-attachment"><el-upload :auto-upload="false" :show-file-list="false" accept="image/*,.pdf,application/pdf" :on-change="file => onChangeAttachmentPicked(file, 'leave_date')"><el-button link type="primary" :loading="attachmentUploading === 'leave_date'">{{ changeAttachments.leave_date.name ? '已附离职材料' : '上传离职材料' }}</el-button></el-upload><span v-if="changeAttachments.leave_date.url" class="field-attachment__name">{{ changeAttachments.leave_date.name || '已上传材料' }}</span></div></el-form-item></el-col></el-row></el-form>
          <AttachmentPreview :items="savedAttachmentItems" :pending="pendingAttachmentItems" />
          </section>
        </el-tab-pane>
        <el-tab-pane name="D"><template #label><span class="level-label level-d"><b>4</b><span>薪资与敏感资料<small>银行与薪酬保密信息</small></span></span></template>
          <section class="profile-section sensitive-section"><el-form label-position="top"><div class="form-divider">银行卡资料</div><el-row :gutter="16"><el-col :span="12"><el-form-item label="开户银行"><el-select v-model="editForm.bank_name" filterable clearable placeholder="请选择开户银行" style="width:100%"><el-option v-for="bank in bankOptions" :key="bank" :label="bank" :value="bank" /></el-select></el-form-item></el-col><el-col :span="12"><el-form-item label="开户银行支行"><el-input v-model="editForm.bank_branch" /></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="银行卡姓名"><el-input v-model="editForm.bank_account_name" /></el-form-item></el-col><el-col :span="12"><el-form-item label="银行卡卡号"><el-input v-model="editForm.bank_card_number" /></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="8"><el-form-item label="银行卡正面照片"><div class="photo-upload"><PhotoThumb :src="editForm.bank_card_front_url" hint="银行卡正面" @picked="file => handlePhotoPick(file, 'bank_card_front_url')" /><el-button v-if="editForm.bank_card_front_url" link type="danger" size="small" @click="clearPhoto('bank_card_front_url')">移除</el-button></div></el-form-item></el-col><el-col :span="8"><el-form-item label="银行卡反面照片"><div class="photo-upload"><PhotoThumb :src="editForm.bank_card_back_url" hint="银行卡反面" @picked="file => handlePhotoPick(file, 'bank_card_back_url')" /><el-button v-if="editForm.bank_card_back_url" link type="danger" size="small" @click="clearPhoto('bank_card_back_url')">移除</el-button></div></el-form-item></el-col></el-row><div class="form-divider">薪酬资料</div><div v-if="editForm.hire_type === '全职'"><el-row :gutter="16"><el-col v-for="item in fullTimeSalaryFields" :key="item.key" :span="8"><el-form-item :label="item.label"><el-input v-model.number="salaryProfile[item.key]" type="number" min="0"><template #append>元</template></el-input></el-form-item></el-col></el-row><el-row :gutter="16"><el-col :span="12"><el-form-item label="工作日加班工价（元/时）"><el-input v-model.number="salaryProfile.weekday_overtime_rate" type="number" min="0" /></el-form-item></el-col></el-row></div><div v-else><el-form-item label="兼职工价（元/时）"><el-input v-model.number="salaryProfile.part_time_hourly_rate" type="number" min="0"><template #append>元/时</template></el-input></el-form-item></div><div class="salary-preview"><div><small>{{ editForm.hire_type === '兼职' ? '统一时薪' : '标准工资' }}</small><b>¥{{ standardSalary.toFixed(2) }}{{ editForm.hire_type === '兼职' ? ' / 时' : ' / 月' }}</b></div><div class="salary-sheet-tip"><small>月度项目</small><span>奖罚、扣缴、实际出勤与加班仅在工资表填写</span></div></div></el-form></section>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button v-if="profileLevel !== 'A'" @click="previousLevel">上一页</el-button>
        <el-button v-if="profileLevel !== 'D'" @click="nextLevel">下一页</el-button>
        <el-button type="primary" @click="saveEdit" :loading="saving">确定</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="lifecycleVisible" :title="`${lifecycleEmployee?.name || ''} · 员工生命线`" width="580px">
      <div v-if="lifecycleLoading" class="lifecycle-empty">正在读取记录…</div>
      <el-timeline v-else-if="lifecycleEvents.length" class="staff-lifecycle"><el-timeline-item v-for="event in lifecycleEvents" :key="event.id" :timestamp="event.event_date" placement="top"><b>{{ event.event_type }}</b><p v-if="event.old_value || event.new_value">{{ event.old_value || '—' }} <span>→</span> {{ event.new_value || '—' }}</p><small v-if="event.note">{{ event.note }}</small><div v-if="event.details?.length" class="lifecycle-details"><span v-for="detail in event.details" :key="detail.label"><b>{{ detail.label }}</b>{{ detail.old_value }} {{ detail.unit || '' }} → {{ detail.new_value }} {{ detail.unit || '' }}</span></div><AttachmentPreview v-if="event.attachment_url" class="lifecycle-attachment-board" :items="[{ url: event.attachment_url, name: event.attachment_name || '调整材料' }]" /><small>{{ event.source }} · {{ event.created_at || event.event_date }}</small></el-timeline-item></el-timeline>
      <div v-else class="lifecycle-empty">暂无生命线记录；后续员工资料变化会自动沉淀在这里。</div>
    </el-dialog>
    <el-dialog v-model="dingtalkVisible" title="钉钉考勤同步" width="570px" class="dingtalk-dialog">
      <div class="dingtalk-status" :class="{ ready: dingtalkStatus.configured }"><b>{{ dingtalkStatus.configured ? '服务已连接' : '等待配置' }}</b><span>{{ dingtalkStatus.message || '正在检查钉钉接入状态…' }}</span></div>
      <el-descriptions :column="2" border size="small" class="dingtalk-meta"><el-descriptions-item label="员工 ID 已绑定">{{ dingtalkStatus.mappedEmployees || 0 }} 人</el-descriptions-item><el-descriptions-item label="同步范围">{{ selectedStaff.length ? `已选 ${selectedStaff.length} 人（已绑定 ${selectedDingTalkCount} 人）` : '全部已绑定员工' }}</el-descriptions-item></el-descriptions>
      <el-form label-position="top" style="margin-top:16px"><el-form-item label="同步日期"><el-date-picker v-model="dingtalkDateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width:100%" /></el-form-item></el-form>
      <p class="dingtalk-hint">可在员工列表勾选后只同步选中员工；未勾选时同步全部已绑定员工。日期超过 7 天会自动分段拉取。钉钉员工 ID 在“基础信息”维护。</p>
      <template #footer><el-button @click="dingtalkVisible = false">关闭</el-button><el-button type="primary" :disabled="!dingtalkStatus.configured || !dingtalkStatus.mappedEmployees || (selectedStaff.length && !selectedDingTalkCount)" :loading="dingtalkSyncing" @click="syncDingTalk">{{ selectedStaff.length ? '同步选中员工' : '同步全部员工' }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="attendanceVisible" :title="`${attendanceEmployee?.name || ''} · 钉钉打卡记录`" width="650px">
      <el-date-picker v-model="attendanceDateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width:330px;margin-bottom:14px" @change="loadAttendance" />
      <el-table :data="attendanceRecords" v-loading="attendanceLoading" size="small" max-height="380"><el-table-column prop="work_date" label="工作日" width="110" /><el-table-column prop="check_time" label="打卡时间" min-width="165" /><el-table-column prop="check_type" label="类型" width="95"><template #default="{ row }">{{ row.check_type === 'OnDuty' ? '上班' : row.check_type === 'OffDuty' ? '下班' : row.check_type || '打卡' }}</template></el-table-column><el-table-column prop="time_result" label="结果" width="90"><template #default="{ row }">{{ row.time_result === 'Normal' ? '正常' : row.time_result === 'Late' ? '迟到' : row.time_result || '—' }}</template></el-table-column><el-table-column prop="location_result" label="地点" width="90"><template #default="{ row }">{{ row.location_result === 'Normal' ? '正常' : row.location_result || '—' }}</template></el-table-column></el-table>
      <div v-if="!attendanceLoading && !attendanceRecords.length" class="lifecycle-empty">该日期范围暂无已同步的钉钉打卡记录。</div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'
import PhotoThumb from '@/components/PhotoThumb.vue'
import AttachmentPreview from '@/components/AttachmentPreview.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createStaff, getConfig, getDingTalkAttendanceStatus, getStaffDingTalkAttendance, getStaffLifecycle, getStaffList, getStaffSalaryProfile, getStaffStats, getStores, importStaffWorkbook, saveStaffSalaryProfile, syncDingTalkAttendance, syncStaffFromWecom, updateStaff } from '@/api'

const stats = ref({ total: 0, active: 0, inactive: 0 })
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const syncing = ref(false)
const importing = ref(false)
const selectedStaff = ref([])
const selectedDingTalkCount = computed(() => selectedStaff.value.filter(row => String(row.dingtalk_user_id || '').trim()).length)
const keyword = ref('')
const status = ref('')
const storeName = ref('')
const stores = ref([])
const GROUP_NAMES = ['永文总公司', '鹅太公连锁', '鹅太公品牌', '同盛']
const affiliationType = ref('')
function affiliationValue(name) { return GROUP_NAMES.includes(name) ? name : stores.value.find(store => store.store_name === name)?.id ?? null }
function affiliationName(value) { return GROUP_NAMES.includes(value) ? value : stores.value.find(store => Number(store.id) === Number(value))?.store_name || '' }
const filterAffiliation = computed({ get: () => affiliationValue(storeName.value), set: value => { storeName.value = affiliationName(value) } })
function onFilterAffiliationChange(value) {
  if (GROUP_NAMES.includes(value)) affiliationType.value = 'group'
  else if (value != null && affiliationType.value === 'group') affiliationType.value = 'store'
  search()
}
function changeAffiliationType() { storeName.value = ''; search() }
const lifecycleVisible = ref(false), lifecycleLoading = ref(false), lifecycleEmployee = ref(null), lifecycleEvents = ref([])
const dingtalkVisible = ref(false), dingtalkSyncing = ref(false), dingtalkStatus = ref({}), dingtalkDateRange = ref([])
const attendanceVisible = ref(false), attendanceLoading = ref(false), attendanceEmployee = ref(null), attendanceRecords = ref([]), attendanceDateRange = ref([])

const editVisible = ref(false)
const saving = ref(false)
const editingId = ref(null)
const profileLevel = ref('A')
const profileMeta = {
  A: { title: '基础信息', description: '员工识别、联系与紧急联系人信息' },
  B: { title: '详细信息', description: '证件、联系、教育与合规资料' },
  C: { title: '人员调整', description: '集团内人员任用、归属与状态调整' },
  D: { title: '薪资与敏感资料', description: '银行与薪酬保密信息，仅限获授权人员维护' },
}
const emptyForm = () => ({
  name: '', photo_url: '', phone: '', dingtalk_user_id: '', gender: '', age: '', store_name: '',
  onboarding_status: '已入职', status: '在职', position: '', job_level: '', entry_date: '',
  hire_type: '全职', salary: '', probation_date: '', leave_date: '',
  id_card_number: '', id_card_front_url: '', id_card_back_url: '',
  bank_name: '', bank_branch: '', bank_account_name: '', bank_card_number: '',
  bank_card_front_url: '', bank_card_back_url: '',
  emergency_contact: '', emergency_phone: '', health_certificate_url: '',
  health_certificate_expiry: '', native_place: '', household_registration: '', household_type: '', contact_address: '',
  labor_relation: '', contract_start_date: '', contract_end_date: '', social_security_number: '',
  education_school: '', education_level: '', graduation_date: '', major: '', remark: ''
})
const editForm = reactive(emptyForm())
const editAffiliation = computed({ get: () => affiliationValue(editForm.store_name), set: value => { editForm.store_name = affiliationName(value) } })
const isGroupEmployee = computed(() => GROUP_NAMES.includes(editForm.store_name))
const derivedEmploymentStatus = computed(() => /^\d{4}-\d{2}-\d{2}$/.test(String(editForm.leave_date || '')) ? '离职' : '在职')
const derivedOnboardingStatus = computed(() => {
  if (derivedEmploymentStatus.value === '离职') return '离职'
  const entry = String(editForm.entry_date || '')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) return '待入职'
  const entryDate = new Date(`${entry}T00:00:00`)
  if (entryDate > today) return '待入职'
  if (Math.floor((today - entryDate) / 86400000) < 3) return '试岗'
  const probation = String(editForm.probation_date || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(probation) && today >= new Date(`${probation}T00:00:00`) ? '正式员工' : '试用期'
})
const educationOptions = ['初中及以下', '高中 / 中专', '大专', '本科', '硕士研究生', '博士研究生']
const storePositionOptions = ['兼职', '实习店长', '二级店长', '一级店长', '实习厨工（学徒）', '实习厨工（备料）', '二级厨工', '一级厨工', '实习服务员', '二级服务员', '一级服务员']
// 多岗位：最多 5 个，其中一个为主岗位；主岗位会同步到 employees.position
const positionLimit = 5
const editPositions = ref([{ position: '', is_primary: true }])
const primaryPositionIndex = ref(0)
function resetPositions(list) {
  const rows = (Array.isArray(list) ? list : []).filter(item => String(item?.position || '').trim()).slice(0, positionLimit)
  editPositions.value = rows.length
    ? rows.map(item => ({ position: String(item.position).trim(), is_primary: Boolean(item.is_primary) }))
    : [{ position: '', is_primary: true }]
  const primaryIdx = editPositions.value.findIndex(item => item.is_primary)
  primaryPositionIndex.value = primaryIdx >= 0 ? primaryIdx : 0
  editPositions.value.forEach((item, index) => { item.is_primary = index === primaryPositionIndex.value })
}
function markPrimary(index) { primaryPositionIndex.value = index; editPositions.value.forEach((item, i) => { item.is_primary = i === index }) }
function addPosition() {
  if (editPositions.value.length >= positionLimit) { ElMessage.warning(`最多只能保留 ${positionLimit} 个岗位`); return }
  editPositions.value.push({ position: '', is_primary: false })
}
function removePosition(index) {
  if (editPositions.value.length <= 1) return
  editPositions.value.splice(index, 1)
  if (primaryPositionIndex.value >= editPositions.value.length) primaryPositionIndex.value = editPositions.value.length - 1
  editPositions.value.forEach((item, i) => { item.is_primary = i === primaryPositionIndex.value })
}
const filledPositions = computed(() => editPositions.value.filter(item => String(item.position || '').trim()))
// 本次新选、尚未保存的材料（本地临时预览）
const pendingAttachmentItems = computed(() => Object.entries(changeAttachments)
  .filter(([, value]) => value?.file)
  .map(([field, value]) => ({ field, name: value.name || value.file?.name || '', file: value.file, url: '' })))
// 已保存的材料（来自各字段留档的 url）
const savedAttachmentItems = computed(() => Object.entries(changeAttachments)
  .filter(([, value]) => value?.url)
  .map(([field, value]) => ({ field, name: value.name || value.url, url: value.url })))
const commonBanks = ['中国工商银行', '中国农业银行', '中国银行', '中国建设银行', '交通银行', '中国邮政储蓄银行', '招商银行', '中信银行', '中国光大银行', '华夏银行', '中国民生银行', '广发银行', '平安银行', '兴业银行', '浦发银行', '浙商银行', '渤海银行', '恒丰银行', '北京银行', '上海银行', '江苏银行', '南京银行', '宁波银行', '杭州银行', '广州银行', '东莞银行', '广东南粤银行', '深圳农商银行', '广州农商银行', '东莞农商银行', '顺德农商银行', '北京农商银行', '上海农商银行', '重庆银行', '重庆农村商业银行', '成都银行', '长沙银行', '厦门银行', '河北省农村信用社']
const bankAliases = { '工商银行': '中国工商银行', '中国农银行': '中国农业银行', '建设银行': '中国建设银行', '光大银行': '中国光大银行' }
// 保留已导入的特殊银行名称供查看，不允许创建自由输入选项。
const bankOptions = computed(() => [...new Set([...commonBanks, ...(editForm.bank_name ? [editForm.bank_name] : [])])])
const phoneError = ref(''), idCardError = ref('')
// 正在上传照片的字段名；用于在对应格子上显示上传中状态，避免重复点击
const photoUploading = ref('')
const attachmentUploading = ref('')
const changeAttachments = reactive({ position: { url: '', name: '' }, probation_date: { url: '', name: '' }, leave_date: { url: '', name: '' } })
// 身份证识别核对状态（人工 2026-09-17 确认：姓名与号码都要一致才算通过）
const ocrState = reactive({ status: '', message: '', scanned: null, expected: null, loading: false })
// 是否由人工声明"已人工核对"以跳过机器核对（针对尚未配置识别服务的情况）
const idVerifyWaived = ref(false)
// 是否强制要求机器核对通过才允许保存（由 config.json 的 idCardOcr.require_id_verification 控制）
const requireIdVerification = ref(false)
const canRunIdCardScan = computed(() => Boolean(editingId.value && editForm.id_card_front_url && editForm.name))
const idCardScanHint = computed(() => {
  if (!editingId.value) return '请先保存员工基础资料，再进行身份证核对'
  if (!editForm.name) return '请先填写姓名'
  if (!editForm.id_card_front_url) return '请先上传身份证正面照片'
  return ''
})
const emptySalaryProfile = () => ({ base_salary: 0, position_allowance: 0, performance_salary: 0, attendance_bonus: 0, housing_allowance: 0, weekday_overtime_rate: 0, restday_overtime_rate: 0, part_time_hourly_rate: 0 })
const salaryProfile = reactive(emptySalaryProfile())
const originalSensitiveValues = ref({})
const originalSalaryProfile = ref({})
const fullTimeSalaryFields = [{ key: 'base_salary', label: '基本工资' }, { key: 'position_allowance', label: '岗位补贴' }, { key: 'performance_salary', label: '绩效工资' }, { key: 'attendance_bonus', label: '全勤奖' }, { key: 'housing_allowance', label: '房租补贴' }]
const salaryAuditFields = ['base_salary', 'position_allowance', 'performance_salary', 'attendance_bonus', 'housing_allowance', 'weekday_overtime_rate', 'restday_overtime_rate', 'part_time_hourly_rate']
const standardSalary = computed(() => editForm.hire_type === '兼职' ? Number(salaryProfile.part_time_hourly_rate || 0) : fullTimeSalaryFields.reduce((sum, item) => sum + Number(salaryProfile[item.key] || 0), 0))

function search() { page.value = 1; loadData() }
function handleStaffSelection(rows) { selectedStaff.value = rows || [] }

async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (keyword.value) params.keyword = keyword.value
    if (status.value) params.status = status.value
    if (storeName.value) params.affiliation_name = storeName.value
    if (affiliationType.value) params.affiliation_type = affiliationType.value
    const data = await getStaffList(params)
    list.value = data.list || []
    total.value = data.total || 0
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message)
  } finally { loading.value = false }
}

async function loadStores() {
  try {
    const data = await getStores({ page: 1, page_size: 500 })
    stores.value = data.stores || []
  } catch {}
}

async function loadStats() {
  try {
    const data = await getStaffStats({})
    if (data.stats) stats.value = data.stats
  } catch {}
}

function resetIdCardVerify() {
  Object.assign(ocrState, { status: '', message: '', scanned: null, expected: null, loading: false })
  idVerifyWaived.value = false
}

function openCreate() {
  editingId.value = null
  Object.assign(editForm, emptyForm())
  Object.assign(salaryProfile, emptySalaryProfile())
  originalSensitiveValues.value = {}
  originalSalaryProfile.value = {}
  resetPositions([])
  Object.assign(changeAttachments.position, { url: '', name: '', file: null }); Object.assign(changeAttachments.probation_date, { url: '', name: '', file: null }); Object.assign(changeAttachments.leave_date, { url: '', name: '', file: null })
  profileLevel.value = 'A'
  resetIdCardVerify()
  editVisible.value = true
}

async function openEdit(row) {
  editingId.value = row.id
  resetIdCardVerify()
  // 多岗位：优先用列表返回的 positions；老数据没有时退回单岗位字段
  resetPositions(Array.isArray(row.positions) && row.positions.length ? row.positions : (row.position ? [{ position: row.position, is_primary: true }] : []))
  Object.assign(editForm, emptyForm(), {
    name: row.name || '', photo_url: row.photo_url || '', phone: row.phone || '', dingtalk_user_id: row.dingtalk_user_id || '', gender: row.gender || '', age: row.age || '',
    store_name: row.store_name || '',
    onboarding_status: row.onboarding_status || '已入职', status: row.status || '在职',
    position: row.position || '', job_level: row.job_level || '', entry_date: row.entry_date || '', hire_type: row.hire_type || '全职',
    salary: row.salary ?? '', probation_date: row.probation_date || '', leave_date: row.leave_date || '',
    id_card_number: row.id_card_number || '', id_card_front_url: row.id_card_front_url || '', id_card_back_url: row.id_card_back_url || '',
    bank_name: bankAliases[row.bank_name] || row.bank_name || '', bank_branch: row.bank_branch || '', bank_account_name: row.bank_account_name || '', bank_card_number: row.bank_card_number || '', bank_card_front_url: row.bank_card_front_url || '', bank_card_back_url: row.bank_card_back_url || '',
    emergency_contact: row.emergency_contact || '', emergency_phone: row.emergency_phone || '',
    health_certificate_url: row.health_certificate_url || '', health_certificate_expiry: row.health_certificate_expiry || '', native_place: row.native_place || '', household_registration: row.household_registration || '', household_type: row.household_type || '', contact_address: row.contact_address || '', labor_relation: row.labor_relation || '', contract_start_date: row.contract_start_date || '', contract_end_date: row.contract_end_date || '', social_security_number: row.social_security_number || '', education_school: row.education_school || '', education_level: row.education_level || '', graduation_date: row.graduation_date || '', major: row.major || '', remark: row.remark || '',
  })
  refreshAge()
  validateFields()
  Object.assign(salaryProfile, emptySalaryProfile())
  try { Object.assign(salaryProfile, (await getStaffSalaryProfile(row.id)).profile || {}) } catch (error) { ElMessage.warning('薪酬构成读取失败，可重新填写保存') }
  originalSalaryProfile.value = { ...salaryProfile }
  Object.assign(changeAttachments.position, { url: '', name: '', file: null }); Object.assign(changeAttachments.probation_date, { url: '', name: '', file: null }); Object.assign(changeAttachments.leave_date, { url: '', name: '', file: null })
  // 回填历史材料：从生命线里取各字段最近一次带附件的事件，
  // 这样重新打开 C 级就能看到已留档的材料，而不是一片空白。
  try {
    const events = (await getStaffLifecycle(row.id)).events || []
    const fieldOfEvent = { 岗位调整: 'position', 转正时间调整: 'probation_date', 离职时间调整: 'leave_date', 材料留档: null }
    events.filter(event => event.attachment_url).forEach(event => {
      // 「材料留档」事件用 new_value 标明材料类型
      const field = event.event_type === '材料留档'
        ? { 岗位: 'position', 转正时间: 'probation_date', 离职时间: 'leave_date' }[String(event.new_value || '').trim()]
        : fieldOfEvent[event.event_type]
      if (field) Object.assign(changeAttachments[field], { url: event.attachment_url, name: event.attachment_name || '', file: null })
    })
  } catch (error) { /* 材料回填失败不阻断编辑 */ }
  originalSensitiveValues.value = {
    salary: Number(standardSalary.value || 0), position: row.position || '', probation_date: row.probation_date || '', job_level: row.job_level || '',
    leave_date: row.leave_date || '', store_name: row.store_name || '',
    health_certificate_expiry: row.health_certificate_expiry || '',
  }
  profileLevel.value = 'A'
  editVisible.value = true
}

// 证件/银行卡照片：不再手填地址，改为选择本地图片。
// 图片上传到后端（POST /api/staff/photos，二进制体），字段只保存返回的受保护地址，
// 与"企业微信附件或受保护文件地址"的既有口径一致，也不把 base64 写进数据库。
const PHOTO_MAX_BYTES = 5 * 1024 * 1024
async function handlePhotoPick(file, field) {
  if (!file) return false
  if (!String(file.type || '').startsWith('image/')) { ElMessage.warning('请选择图片文件（jpg / png / webp / gif）'); return false }
  if (file.size > PHOTO_MAX_BYTES) { ElMessage.warning('图片不能超过 5 MB，请先压缩后再上传'); return false }
  photoUploading.value = field
  try {
    const token = localStorage.getItem('etaigong_token')
    const response = await fetch('/api/staff/photos', {
      method: 'POST',
      headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || `上传失败（${response.status}）`)
    editForm[field] = body.url
    ElMessage.success('图片已上传，保存后生效')
  } catch (error) { ElMessage.error(error.message || '图片上传失败') }
  finally { photoUploading.value = '' }
  return false // 已自行上传，禁用组件默认的自动上传
}
function clearPhoto(field) { editForm[field] = '' }
async function onChangeAttachmentPicked(uploadFile, field) {
  const file = uploadFile?.raw
  if (!file) return
  if (!(String(file.type || '').startsWith('image/') || file.type === 'application/pdf')) { ElMessage.warning('请选择图片或 PDF 附件'); return }
  if (file.size > 10 * 1024 * 1024) { ElMessage.warning('附件不能超过 10 MB'); return }
  attachmentUploading.value = field
  try {
    const token = localStorage.getItem('etaigong_token')
    const response = await fetch('/api/staff/attachments', { method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || '附件上传失败')
    Object.assign(changeAttachments[field], { url: body.url, name: body.name || file.name, file })
    ElMessage.success('调整材料已上传')
  } catch (error) { ElMessage.error(error.message || '附件上传失败') }
  finally { attachmentUploading.value = '' }
}


// 身份证识别核对：把身份证正面照交给后端 OCR，比对姓名与号码是否与当前员工档案一致。
// 未配置识别服务时后端返回 not_configured，这里只提示，不报错。
async function runIdCardScan() {
  if (!canRunIdCardScan.value) { ElMessage.warning(idCardScanHint.value || '条件不足，无法核对'); return }
  ocrState.loading = true
  try {
    const token = localStorage.getItem('etaigong_token')
    const imageRes = await fetch(editForm.id_card_front_url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!imageRes.ok) throw new Error(`读取身份证照片失败（${imageRes.status}）`)
    const blob = await imageRes.blob()
    const scanRes = await fetch(`/api/staff/idcard-scan?employee_id=${editingId.value}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: blob,
    })
    const body = await scanRes.json().catch(() => ({}))
    if (!scanRes.ok) throw new Error(body.error || `核对失败（${scanRes.status}）`)
    Object.assign(ocrState, {
      status: body.status || '', message: body.message || '',
      scanned: body.scanned || null, expected: body.expected || null,
    })
    if (body.status === 'pass') ElMessage.success('核对通过：姓名与身份证号均一致')
    else if (body.status === 'not_configured') ElMessage.warning(body.message)
    else ElMessage.error(body.message || '核对未通过')
  } catch (error) {
    Object.assign(ocrState, { status: 'error', message: error.message || '核对失败', scanned: null, expected: null })
    ElMessage.error(error.message || '核对失败')
  } finally { ocrState.loading = false }
}

function refreshAge() {
  const match = String(editForm.id_card_number || '').trim().match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[0-9Xx]$/)
  if (!match) { editForm.age = ''; return }
  const birthday = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (birthday.getFullYear() !== Number(match[1]) || birthday.getMonth() !== Number(match[2]) - 1 || birthday.getDate() !== Number(match[3])) { editForm.age = ''; return }
  const today = new Date()
  let age = today.getFullYear() - birthday.getFullYear()
  if (today.getMonth() < birthday.getMonth() || (today.getMonth() === birthday.getMonth() && today.getDate() < birthday.getDate())) age -= 1
  editForm.age = age >= 0 && age <= 130 ? age : ''
}

function validateFields() {
  const phone = String(editForm.phone || '').trim()
  phoneError.value = phone && !/^1[3-9]\d{9}$/.test(phone) ? '请输入 11 位中国大陆手机号' : ''
  const card = String(editForm.id_card_number || '').trim().toUpperCase()
  if (!card) { idCardError.value = ''; return }
  const match = card.match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[0-9X]$/)
  if (!match) { idCardError.value = '请输入 18 位身份证号码'; return }
  const birth = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (birth.getFullYear() !== Number(match[1]) || birth.getMonth() !== Number(match[2]) - 1 || birth.getDate() !== Number(match[3])) { idCardError.value = '身份证出生日期不正确'; return }
  const weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2], checks = '10X98765432'
  idCardError.value = checks[card.slice(0,17).split('').reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 11] === card[17] ? '' : '身份证校验码不正确'
}
function onIdCardInput() { refreshAge(); validateFields() }
async function openLifecycle(row) {
  lifecycleVisible.value = true; lifecycleLoading.value = true; lifecycleEmployee.value = row; lifecycleEvents.value = []
  try { lifecycleEvents.value = (await getStaffLifecycle(row.id)).events || [] }
  catch (error) { ElMessage.error('生命线读取失败：' + error.message) }
  finally { lifecycleLoading.value = false }
}
async function openDingTalk() {
  dingtalkVisible.value = true
  const today = new Date().toISOString().slice(0, 10)
  dingtalkDateRange.value = [today, today]
  try { dingtalkStatus.value = await getDingTalkAttendanceStatus() }
  catch (error) { ElMessage.error('无法读取钉钉接入状态：' + error.message) }
}
async function syncDingTalk() {
  const [date_from, date_to] = dingtalkDateRange.value || []
  if (!date_from || !date_to) { ElMessage.warning('请选择同步日期'); return }
  dingtalkSyncing.value = true
  try {
    const result = await syncDingTalkAttendance({ date_from, date_to, employee_ids: selectedStaff.value.map(row => row.id) })
    ElMessage.success(result.message || '钉钉考勤已同步')
    dingtalkStatus.value = await getDingTalkAttendanceStatus()
  } catch (error) { ElMessage.error('同步失败：' + error.message) }
  finally { dingtalkSyncing.value = false }
}
async function openAttendance(row) {
  attendanceVisible.value = true; attendanceEmployee.value = row; attendanceRecords.value = []
  const today = new Date().toISOString().slice(0, 10)
  attendanceDateRange.value = [today, today]
  await loadAttendance()
}
async function loadAttendance() {
  if (!attendanceEmployee.value) return
  const [date_from, date_to] = attendanceDateRange.value || []
  if (!date_from || !date_to) return
  attendanceLoading.value = true
  try { attendanceRecords.value = (await getStaffDingTalkAttendance(attendanceEmployee.value.id, { date_from, date_to })).records || [] }
  catch (error) { ElMessage.error('考勤记录读取失败：' + error.message) }
  finally { attendanceLoading.value = false }
}

function nextLevel() {
  profileLevel.value = profileLevel.value === 'A' ? 'B' : profileLevel.value === 'B' ? 'C' : 'D'
}

function previousLevel() {
  profileLevel.value = profileLevel.value === 'D' ? 'C' : profileLevel.value === 'C' ? 'B' : 'A'
}

async function saveEdit() {
  if (!editForm.name.trim()) { ElMessage.warning('姓名不能为空'); return }
  validateFields()
  if (phoneError.value || idCardError.value) { ElMessage.warning('请先修正手机号或身份证号码'); return }
  // 多岗位：主岗位同步回单岗位字段，职位列与工资表都读它
  const blankPosition = editPositions.value.findIndex(item => !String(item.position || '').trim())
  if (editPositions.value.length > 1 && blankPosition >= 0) { ElMessage.warning(`第 ${blankPosition + 1} 个岗位还没选，请选择或删除该行`); return }
  const primaryPosition = (filledPositions.value.find(item => item.is_primary) || filledPositions.value[0])?.position || ''
  editForm.position = primaryPosition
  // 身份证核对门禁：严格口径下必须机器核对通过；未配置识别服务时可由人工声明通过。
  if (!idVerifyWaived.value && ocrState.status !== 'pass' && (requireIdVerification.value || ocrState.status === 'mismatch')) {
    const reason = ocrState.status === 'mismatch'
      ? `身份证核对未通过：${ocrState.message}`
      : (ocrState.status === 'not_configured' ? '尚未配置身份证识别服务' : '请先执行「身份证识别核对」')
    try {
      await ElMessageBox.confirm(`${reason}。仍要保存吗？`, '身份证核对未通过', { type: 'warning', confirmButtonText: '仍要保存', cancelButtonText: '返回核对' })
    } catch { return }
  }
  const sensitiveLabels = {
    salary: '工资', position: '岗位', job_level: '职级', leave_date: '离职时间',
    store_name: '归属门店', health_certificate_expiry: '健康证失效时间',
  }
  const currentSensitive = {
    salary: standardSalary.value, position: editForm.position || '', job_level: editForm.job_level || '',
    leave_date: editForm.leave_date || '', store_name: editForm.store_name || '',
    health_certificate_expiry: editForm.health_certificate_expiry || '',
  }
  const salaryStructureChanged = editingId.value && salaryAuditFields.some(field => Number(originalSalaryProfile.value[field] || 0) !== Number(salaryProfile[field] || 0))
  const salaryLabels = { base_salary: '基础工资', position_allowance: '岗位补贴', performance_salary: '绩效工资', attendance_bonus: '全勤奖', housing_allowance: '房补', weekday_overtime_rate: '工作日加班工价', restday_overtime_rate: '休息日加班工价', part_time_hourly_rate: '兼职时薪' }
  const salaryStructureDetails = salaryAuditFields.filter(field => Number(originalSalaryProfile.value[field] || 0) !== Number(salaryProfile[field] || 0)).map(field => ({ label: salaryLabels[field], old_value: Number(originalSalaryProfile.value[field] || 0), new_value: Number(salaryProfile[field] || 0), unit: field.includes('rate') || field === 'part_time_hourly_rate' ? '元/时' : '元/月' }))
  const changedSensitive = editingId.value ? Object.keys(sensitiveLabels).filter(field => field === 'salary'
    ? Number(originalSensitiveValues.value[field]) !== Number(currentSensitive[field]) || salaryStructureChanged
    : String(originalSensitiveValues.value[field] || '') !== String(currentSensitive[field] || '')) : []
  const attachmentRequired = editingId.value && ['position', 'probation_date', 'leave_date'].some(field => String(originalSensitiveValues.value[field] || '') !== String(editForm[field] || ''))
  const missingAttachment = ['position', 'probation_date', 'leave_date'].filter(field => String(originalSensitiveValues.value[field] || '') !== String(editForm[field] || '') && !changeAttachments[field].url)
  if (attachmentRequired && missingAttachment.length) { ElMessage.warning(`请分别上传${missingAttachment.map(field => ({ position: '岗位', probation_date: '转正时间', leave_date: '离职时间' }[field])).join('、')}对应的材料`); return }
  let changeReason = ''
  if (changedSensitive.length) {
    try {
      const result = await ElMessageBox.prompt(`已调整：${changedSensitive.map(field => sensitiveLabels[field]).join('、')}。请填写调整原因，保存后将记入员工生命线。`, '填写调整原因', {
        inputType: 'textarea', inputPlaceholder: '请说明调整原因', inputValidator: value => String(value || '').trim() ? true : '调整原因不能为空',
        confirmButtonText: '确认保存', cancelButtonText: '取消',
      })
      changeReason = String(result.value || '').trim()
    } catch { return }
  }
  saving.value = true
  try {
    const payload = {
      name: editForm.name.trim(),
      photo_url: editForm.photo_url || '',
      phone: editForm.phone || '',
      dingtalk_user_id: editForm.dingtalk_user_id || '',
      gender: editForm.gender || '',
      store_name: editForm.store_name || '',
      change_reason: changeReason,
      change_attachments: changeAttachments,

      status: derivedEmploymentStatus.value,
      position: editForm.position || '',
      positions: filledPositions.value.map(item => ({ position: item.position, is_primary: item.is_primary })),
      job_level: editForm.job_level || '',
      entry_date: editForm.entry_date || '',
      hire_type: editForm.hire_type || '全职',
      salary: standardSalary.value,
      salary_structure_details: salaryStructureDetails,
      probation_date: editForm.probation_date || '',
      leave_date: editForm.leave_date || '',
      id_card_number: editForm.id_card_number || '',
      id_card_front_url: editForm.id_card_front_url || '',
      id_card_back_url: editForm.id_card_back_url || '',
      bank_name: editForm.bank_name || '',
      bank_branch: editForm.bank_branch || '',
      bank_account_name: editForm.bank_account_name || '',
      bank_card_number: editForm.bank_card_number || '',
      bank_card_front_url: editForm.bank_card_front_url || '',
      bank_card_back_url: editForm.bank_card_back_url || '',
      emergency_contact: editForm.emergency_contact || '',
      emergency_phone: editForm.emergency_phone || '',
      health_certificate_url: editForm.health_certificate_url || '',
      health_certificate_expiry: editForm.health_certificate_expiry || '',
      native_place: editForm.native_place || '',
      household_registration: editForm.household_registration || '',
      household_type: editForm.household_type || '',
      contact_address: editForm.contact_address || '',
      labor_relation: editForm.labor_relation || '',
      contract_start_date: editForm.contract_start_date || '',
      contract_end_date: editForm.contract_end_date || '',
      social_security_number: editForm.social_security_number || '',
      education_school: isGroupEmployee.value ? editForm.education_school || '' : '',
      education_level: isGroupEmployee.value ? editForm.education_level || '' : '',
      graduation_date: isGroupEmployee.value ? editForm.graduation_date || '' : '',
      major: isGroupEmployee.value ? editForm.major || '' : '',
      remark: editForm.remark || '',
    }
    const saved = editingId.value ? await updateStaff(editingId.value, payload) : await createStaff(payload)
    await saveStaffSalaryProfile(editingId.value || saved.id, { ...salaryProfile, change_reason: changeReason })
    editVisible.value = false
    loadData(); loadStats()
    ElMessage.success('保存成功（如已配置企微智能表格将同步）')
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally { saving.value = false }
}

async function syncFromSheet() {
  try {
    await ElMessageBox.confirm('以企业微信机器人身份读取「门店员工管理」智能表格，并同步到本地员工档案？（按企微记录标识去重，重复执行只更新不重复新增）', '从企微同步', { confirmButtonText: '开始同步', cancelButtonText: '取消', type: 'info' })
  } catch { return }
  syncing.value = true
  try {
    const res = await syncStaffFromWecom()
    ElMessage.success(res.message || `同步完成：新增 ${res.created || 0} 人，更新 ${res.updated || 0} 人`)
    await loadData(); await loadStats()
  } catch (e) {
    ElMessage.error('同步失败：' + (e.message || '') + '（请确认已安装 wecom-cli 且完成授权，并已配置企微文档 ID）')
  } finally { syncing.value = false }
}

// 导入本地表格文件（Excel/CSV）：字段自动识别，按 姓名+手机号 去重
function onFilePicked(uploadFile) {
  const file = uploadFile?.raw
  if (!file) return
  importing.value = true
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const res = await importStaffWorkbook({ filename: file.name, data: String(reader.result || '') })
      ElMessage.success(`导入完成：新增 ${res.created || 0} 人，更新 ${res.updated || 0} 人，跳过 ${res.skipped || 0} 行`)
      await loadData(); await loadStats()
    } catch (e) {
      ElMessage.error('导入失败：' + (e.message || ''))
    } finally { importing.value = false }
  }
  reader.onerror = () => { importing.value = false; ElMessage.error('文件读取失败') }
  reader.readAsDataURL(file)
}

onMounted(() => {
  loadData(); loadStats(); loadStores()
  // 读取是否强制要求身份证核对通过（config.json → idCardOcr.require_id_verification）
  getConfig().then(cfg => { requireIdVerification.value = Boolean(cfg?.idCardOcr?.require_id_verification) }).catch(() => {})
})
</script>

<style scoped>

.staff-employees-page { max-width:1440px; margin:0 auto; padding:4px 0 34px; color:#263750; }
.staff-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:16px; padding:22px 26px; border:1px solid #dbe8fb; border-radius:18px; background:linear-gradient(120deg,#f5f9ff 0%,#eef6ff 56%,#f8fbff 100%); box-shadow:0 10px 28px rgba(38,93,168,.06); }
.staff-kicker { display:block; margin-bottom:5px; color:#5b82b9; font-size:12px; font-weight:700; letter-spacing:.08em; }
.staff-hero h1,.staff-query-card h2,.staff-table-card h2 { margin:0; color:#213b61; font-weight:700; }
.staff-hero h1 { font-size:22px; line-height:1.25; }
.staff-hero p,.staff-query-card p { margin:7px 0 0; color:#8191a8; font-size:13px; }
.staff-hero__actions { display:flex; align-items:center; justify-content:flex-end; gap:9px; flex-wrap:wrap; }
.staff-stat-grid { margin:0 0 16px; }
.staff-query-card,.staff-table-card { margin-bottom:16px; padding:20px 22px; border:1px solid #e4ebf4; border-radius:18px; background:#fff; box-shadow:0 8px 24px rgba(32,68,112,.045); }
.staff-query-card__header,.staff-table-card__header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
.staff-query-card h2,.staff-table-card h2 { font-size:17px; }
.staff-table-card h2 small { margin-left:6px; color:#8795a9; font-size:13px; font-weight:400; }
.staff-affiliation-tabs { display:flex; align-items:center; gap:14px; margin-bottom:14px; padding:11px 13px; border-radius:12px; background:#f7faff; }
.staff-affiliation-tabs>span { color:#6e7f96; font-size:13px; font-weight:600; white-space:nowrap; }
.staff-filter-grid { display:grid; grid-template-columns:minmax(180px,1.3fr) minmax(130px,.72fr) minmax(190px,1fr) auto; gap:12px; align-items:center; }
.staff-filter-grid :deep(.el-select),.staff-filter-grid :deep(.store-region-select) { width:100%; }
.staff-filter-grid .el-button { min-width:86px; }
.staff-query-note { padding-top:12px; border-top:1px solid #edf1f6; }
.staff-table-card { padding-bottom:18px; }
.staff-table-card__actions { display:flex; align-items:center; gap:9px; }
.staff-table { overflow:hidden; border:1px solid #e8edf4; border-radius:12px; }
.staff-table :deep(th.el-table__cell) { height:46px; color:#51677f; font-size:13px; font-weight:700; background:#f6f9fd !important; }
.staff-table :deep(td.el-table__cell) { height:52px; color:#3e536c; }
.staff-table :deep(.el-table__row:hover > td.el-table__cell) { background:#f6faff !important; }
.staff-row-actions { display:flex; align-items:center; gap:3px; white-space:nowrap; }
.staff-row-actions .el-button + .el-button { margin-left:0; }
@media (max-width: 900px) { .staff-hero { align-items:flex-start; flex-direction:column; }.staff-hero__actions { justify-content:flex-start; }.staff-filter-grid { grid-template-columns:1fr 1fr; }.staff-filter-grid .el-button { width:100%; }.staff-table-card { overflow:hidden; } }
@media (max-width: 620px) { .staff-employees-page { padding-bottom:22px; }.staff-hero,.staff-query-card,.staff-table-card { padding:17px 15px; border-radius:14px; }.staff-affiliation-tabs { align-items:flex-start; flex-direction:column; }.staff-filter-grid { grid-template-columns:1fr; }.staff-query-card__header,.staff-table-card__header { align-items:flex-start; flex-direction:column; }.staff-table-card__actions { width:100%; justify-content:space-between; } }
.current-level-heading { display:flex; justify-content:center; align-items:center; gap:11px; margin:0 0 18px; padding:14px 18px; border:1px solid #dde8f7; border-radius:16px; background:#f8fbff; text-align:left; }.current-level-heading>span { display:grid; place-items:center; width:31px; height:31px; border-radius:50%; color:#fff; background:#3778e7; font-weight:800; }.current-level-heading div { display:grid; gap:3px; }.current-level-heading b { color:#25476f; font-size:15px; }.current-level-heading small { color:#8291a7; font-size:12px; }.current-b>span { background:#13a58a; }.current-c { border-color:#e6dafa; background:#fcfaff; }.current-c>span { background:#8b61d9; }.current-d { border-color:#f1d9d2; background:#fffaf8; }.current-d>span { background:#c76b4f; }
.profile-level-tabs :deep(.el-tabs__header) { display:none; }
.profile-level-tabs :deep(.el-tab-pane) { animation: profile-pane-in .28s cubic-bezier(.2,.8,.2,1); }
.level-label { display:flex; justify-content:center; align-items:center; gap:9px; height:100%; text-align:left; }.level-label b { display:grid; place-items:center; width:27px; height:27px; border-radius:50%; color:#fff; font-size:13px; }.level-label span { display:grid; gap:2px; color:#304766; font-weight:600; line-height:1.1; }.level-label small { color:#94a1b4; font-size:11px; font-weight:400; }.level-a b { background:#3778e7; }.level-b b { background:#13a58a; }.level-c b { background:#8b61d9; }.level-d b { background:#c76b4f; }.personnel-section { background:linear-gradient(145deg,#fff,#fcfaff); }
.profile-section { padding:22px 22px 5px; border:1px solid #e2e9f3; border-radius:18px; background:#fff; box-shadow:0 10px 30px rgba(41,73,117,.04); }.sensitive-section { border-color:#e5dcfa; background:linear-gradient(145deg,#fff,#fbf9ff); }
/* 证件 / 银行卡照片：格子本体（尺寸、空态、预览放大、选图触发）全部由
   @/components/PhotoThumb.vue 负责，这里只管「格子 + 移除按钮」的纵向排布。 */
.photo-upload { display:flex; width:100%; min-width:0; flex-direction:column; gap:4px; align-items:stretch; }
/* Element Plus 的上传根节点会按内容收缩；空态也必须占满整个图片格。 */
.photo-upload :deep(.el-upload), .personal-photo :deep(.el-upload), .photo-upload :deep(.el-upload.photo-box-host), .personal-photo :deep(.el-upload.photo-box-host) { display:block !important; width:100% !important; min-width:100% !important; }
.photo-upload :deep(.photo-box), .personal-photo :deep(.photo-box), .photo-upload :deep(.photo-box.is-empty), .personal-photo :deep(.photo-box.is-empty) { display:flex !important; width:100% !important; min-width:100% !important; box-sizing:border-box; }
/* 身份证识别核对：工具栏 + 结论提示 */
.idcard-verify { margin:-6px 0 14px; }
.idcard-verify__bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.idcard-verify__alert { margin-top:8px; }
.idcard-verify__alert :deep(.el-alert__content) { line-height:1.7; }
.idcard-verify__alert small { color:#7b8ea6; font-size:11px; }
.idcard-verify__hint { color:#9aa9bd; font-size:11px; }
.identity-row { display:flex; align-items:flex-start; gap:16px; margin-bottom:9px; padding:14px; border-radius:14px; background:#f8fbff; }.personal-photo { display:grid; flex:0 0 210px; gap:6px; color:#5c6f88; font-size:12px; font-weight:600; }.identity-row__fields { min-width:0; flex:1; }.personal-photo :deep(.photo-box) { height:192px; }.personal-photo :deep(.el-button) { justify-self:start; padding:0; }
.form-divider { margin:9px 0 14px; padding-top:16px; border-top:1px solid #e8e4f3; color:#66518f; font-size:13px; font-weight:700; }.salary-preview { display:grid; grid-template-columns:1fr 2fr; overflow:hidden; border:1px solid #e6ddf8; border-radius:14px; background:#fff; }.salary-preview>div { display:grid; gap:5px; padding:13px 15px; border-right:1px solid #eee8f8; }.salary-preview>div:last-child { border:0; background:#f8f5ff; }.salary-preview small { color:#8d82a4; font-size:12px; }.salary-preview b { color:#554078; font-size:18px; }.salary-sheet-tip span { color:#756b88; font-size:12px; line-height:1.5; }
.staff-lifecycle { padding:8px 6px 0; }.staff-lifecycle b { color:#315d93; font-size:14px; }.change-attachment { display:flex; align-items:center; gap:12px; margin:0 0 16px; padding:12px 14px; border-radius:12px; background:#f8fbff; }.change-attachment>div { display:grid; gap:3px; flex:1; }.change-attachment small { color:#8090a6; font-size:12px; }.field-attachment { display:flex; align-items:center; gap:7px; min-height:22px; margin-top:4px; }.field-attachment a { color:#2e6fc7; font-size:12px; text-decoration:none; }.change-attachment a,.lifecycle-attachment { color:#2e6fc7; font-size:12px; text-decoration:none; }
.position-extra { display:inline-block; margin-left:6px; padding:0 5px; border-radius:8px; color:#3568b0; background:#eef5ff; font-size:10px; }
.multi-position { display:grid; gap:10px; padding:12px; border:1px solid #e2e9f4; border-radius:12px; background:#fbfcff; }
.multi-position__row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:12px; }
.multi-position__row .el-select,.multi-position__row .el-input { min-width:0; width:100%; }
.multi-position__primary { flex:none; margin:0; white-space:nowrap; }
.multi-position__actions { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:8px; border-top:1px dashed #dce6f2; }
.multi-position__actions small { color:#8b9aad; font-size:11px; }
.personnel-section .field-attachment { margin-top:9px; padding:8px 10px; border-radius:8px; background:#f7faff; }
@media (max-width: 760px) { .multi-position__row { grid-template-columns:1fr; gap:8px; }.multi-position__actions { align-items:flex-start; flex-direction:column; } }
.field-attachment__name { color:#5b789d; font-size:12px; }
.lifecycle-attachment-board { margin:8px 0 6px; }
.lifecycle-attachment-board :deep(.attachment-board) { margin:0; }.lifecycle-details { display:grid; gap:5px; margin:8px 0; padding:9px 10px; border-radius:8px; background:#f6f9fd; }.lifecycle-details span { color:#687b92; font-size:12px; }.lifecycle-details b { display:inline-block; min-width:88px; margin-right:7px; color:#385b85; font-size:12px; }.lifecycle-attachment { display:block; margin:6px 0; }.staff-lifecycle p { margin:6px 0 3px; color:#5c6f88; font-size:12px; }.staff-lifecycle p span { padding:0 5px; color:#91a0b3; }.staff-lifecycle small,.lifecycle-empty { color:#8c9aad; font-size:12px; }.lifecycle-empty { padding:28px 0; text-align:center; }
.dingtalk-status { display:grid; gap:6px; margin-bottom:14px; padding:14px 16px; border:1px solid #f2d8a2; border-radius:14px; color:#8c6518; background:#fffbef; }.dingtalk-status.ready { border-color:#bde7d6; color:#14725b; background:#f2fbf7; }.dingtalk-status span,.dingtalk-hint { color:#8291a7; font-size:12px; line-height:1.65; }.dingtalk-meta { margin-top:2px; }.dingtalk-hint { margin:0; }
@keyframes profile-pane-in { from { opacity:0; transform:translateY(10px) scale(.99); } to { opacity:1; transform:translateY(0) scale(1); } }
@media (max-width: 720px) { .profile-section { padding:16px 14px 2px; }.identity-row { align-items:stretch; flex-direction:column; }.personal-photo { flex-basis:auto; max-width:none; }.current-level-heading { align-items:flex-start; justify-content:flex-start; }.salary-preview { grid-template-columns:1fr; }.salary-preview>div { border-right:0; border-bottom:1px solid #eee8f8; }.salary-preview>div:last-child { border-bottom:0; } }
</style>
