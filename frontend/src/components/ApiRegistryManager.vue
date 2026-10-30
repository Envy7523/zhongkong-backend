<template>
  <section class="registry" v-loading="loading">
    <header class="registry-head">
      <div>
        <h2>平台与 API 管理</h2>
        <p>
          先登记平台，再维护其 API。保存配置不会启动采集、发送消息或切换机器人。
        </p>
      </div>
      <div>
        <el-button :loading="loading" @click="load">刷新列表</el-button
        ><el-button type="primary" @click="editPlatform()">新增平台</el-button>
      </div>
    </header>
    <el-alert
      v-if="notice"
      :title="notice"
      :type="noticeType"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="state.legacyCount"
      type="warning"
      :closable="false"
      show-icon
      class="legacy"
    >
      发现
      {{
        state.legacyCount
      }}
      条旧模型配置。迁移将保留模型编号与当前引用，把凭据写入加密存储并清除旧模型明文配置。
      <el-button :loading="busy" @click="migrate">迁移旧模型</el-button>
    </el-alert>
    <div class="registry-body">
      <aside class="platform-list" aria-label="平台筛选">
        <button :class="{ selected: !selected }" @click="selected = ''">
          <b>全部平台</b><span>{{ state.apis.length }} 个 API</span>
        </button>
        <button
          v-for="p in state.platforms"
          :key="p.id"
          :class="{ selected: selected === p.id }"
          @click="selected = p.id"
        >
          <b>{{ p.name }}</b
          ><span
            >{{ count(p.id) }} 个 API · {{ p.enabled ? "启用" : "停用" }}</span
          >
        </button>
      </aside>
      <div class="api-list">
        <div class="api-toolbar">
          <div>
            <h3>{{ currentPlatform?.name || "所有 API 引用" }}</h3>
            <p>
              {{
                currentPlatform?.description ||
                "统一查看认证状态、模型及当前使用位置。密钥不回显、不导出。"
              }}
            </p>
          </div>
          <div>
            <el-button
              v-if="currentPlatform"
              @click="editPlatform(currentPlatform)"
              >编辑平台</el-button
            >
            <el-button
              v-if="currentPlatform"
              @click="removePlatform(currentPlatform)"
              >删除平台</el-button
            >
            <el-button
              type="primary"
              :disabled="!state.platforms.length"
              @click="editApi()"
              >新增 API</el-button
            >
          </div>
        </div>
        <el-table
          :data="filtered"
          empty-text="先新增平台，再添加该平台的 API 引用"
          row-key="id"
        >
          <el-table-column label="API / 平台" min-width="170"
            ><template #default="{ row }"
              ><strong>{{ row.name }}</strong
              ><small>{{ platformName(row.platformId) }}</small
              ><small>{{
                row.kind === "openai" ? `模型 · ${row.model}` : "通用 REST 引用"
              }}</small></template
            ></el-table-column
          >
          <el-table-column label="调用地址" min-width="190"
            ><template #default="{ row }"
              ><small>{{
                row.method || (row.kind === "openai" ? "POST" : "GET")
              }}</small
              ><span class="endpoint"
                >{{ row.baseUrl }}{{ row.endpointPath }}</span
              ></template
            ></el-table-column
          >
          <el-table-column label="认证与状态" min-width="145"
            ><template #default="{ row }"
              ><el-tag
                :type="
                  row.enabled && platformEnabled(row.platformId)
                    ? 'success'
                    : 'info'
                "
                >{{
                  row.enabled && platformEnabled(row.platformId)
                    ? "已启用"
                    : "已停用"
                }}</el-tag
              ><small>{{
                row.secretConfigured ? "密钥已加密保存" : "无需密钥"
              }}</small></template
            ></el-table-column
          >
          <el-table-column label="使用位置" min-width="180"
            ><template #default="{ row }"
              ><small v-for="item in row.references" :key="item">{{
                item
              }}</small
              ><small v-if="!row.references.length"
                >已登记，尚未绑定业务</small
              ></template
            ></el-table-column
          >
          <el-table-column label="操作" width="170" fixed="right"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="editApi(row)"
                >编辑</el-button
              ><el-button
                v-if="row.kind === 'openai'"
                link
                :disabled="
                  busy || !row.enabled || !platformEnabled(row.platformId)
                "
                @click="test(row)"
                >验证</el-button
              ><el-button link type="danger" @click="removeApi(row)"
                >删除</el-button
              ></template
            ></el-table-column
          >
        </el-table>
        <p class="help">
          模型协议：OpenAI 兼容 Chat Completions。通用 REST
          用于登记第三方接口引用，不会自动执行未知接口；新增采集报表仍需相应解析适配。
        </p>
      </div>
    </div>
    <section class="binding">
      <div>
        <h3>机器人模型引用</h3>
        <p>
          从已启用的模型 API 中选择。保存后对下一次问答生效，不执行测试消息。
        </p>
      </div>
      <div class="binding-controls">
        <el-switch
          v-model="binding.aiEnabled"
          active-text="启用模型"
        /><el-select
          v-model="binding.activeAiProfileId"
          placeholder="选择模型 API"
          ><el-option
            label="本地模拟解读（不调用外部API）"
            value="local-simulation" /><el-option
            v-for="a in state.legacyProfiles"
            :key="a.id"
            :label="`${a.name}（旧配置，待迁移）`"
            :value="a.id"
            disabled /><el-option
            v-for="a in models"
            :key="a.id"
            :label="`${platformName(a.platformId)} / ${a.name}`"
            :value="a.id" /></el-select
        ><el-button
          type="primary"
          :loading="busy"
          :disabled="
            binding.activeAiProfileId !== 'local-simulation' &&
            !models.some((a) => a.id === binding.activeAiProfileId)
          "
          @click="saveBinding"
          >保存引用</el-button
        >
      </div>
    </section>
    <el-collapse class="audit"
      ><el-collapse-item
        title="变更记录（仅记录操作者、动作与编号，不记录密钥）"
        ><el-table :data="state.audit.slice(0, 50)"
          ><el-table-column
            prop="at"
            label="时间"
            min-width="200" /><el-table-column
            prop="actor"
            label="操作人" /><el-table-column
            prop="action"
            label="操作" /><el-table-column
            prop="id"
            label="配置编号"
            min-width="210" /></el-table></el-collapse-item
    ></el-collapse>

    <el-dialog
      v-model="platformDialog"
      :title="platformForm.id ? '编辑平台' : '新增平台'"
      width="520px"
      :close-on-click-modal="false"
      @closed="clearPlatform"
    >
      <el-alert
        v-if="noticeType === 'error'"
        :title="notice"
        type="error"
        :closable="false"
      />
      <el-form label-position="top"
        ><el-form-item label="平台名称"
          ><el-input v-model="platformForm.name" maxlength="80" /></el-form-item
        ><el-form-item label="说明"
          ><el-input
            v-model="platformForm.description"
            type="textarea"
            maxlength="200" /></el-form-item
        ><el-form-item label="平台状态"
          ><el-switch
            v-model="platformForm.enabled"
            active-text="启用"
            inactive-text="停用" /></el-form-item
      ></el-form>
      <template #footer
        ><el-button @click="platformDialog = false">取消</el-button
        ><el-button type="primary" :loading="busy" @click="savePlatform"
          >保存平台</el-button
        ></template
      >
    </el-dialog>
    <el-dialog
      v-model="apiDialog"
      :title="apiForm.id ? '编辑 API 引用' : '新增 API 引用'"
      width="660px"
      :close-on-click-modal="false"
      @closed="clearApi"
    >
      <el-alert
        v-if="noticeType === 'error'"
        :title="notice"
        type="error"
        :closable="false"
      />
      <el-alert
        type="info"
        :closable="false"
        title="已保存密钥不回显；留空保留。修改地址或认证方式时，必须重新录入密钥。"
      />
      <el-form label-position="top" class="api-form" autocomplete="off">
        <div class="form-pair">
          <el-form-item label="所属平台"
            ><el-select v-model="apiForm.platformId"
              ><el-option
                v-for="p in state.platforms"
                :key="p.id"
                :label="p.name"
                :value="p.id" /></el-select></el-form-item
          ><el-form-item label="API 名称"
            ><el-input v-model="apiForm.name" maxlength="80"
          /></el-form-item>
        </div>
        <el-form-item label="协议类型"
          ><el-select v-model="apiForm.kind"
            ><el-option label="AI 模型 · OpenAI兼容" value="openai" /><el-option
              label="通用 REST · 接口引用登记"
              value="rest" /></el-select
        ></el-form-item>
        <el-form-item label="API 基础地址（公网 HTTPS，不含密钥或参数）"
          ><el-input
            v-model="apiForm.baseUrl"
            placeholder="https://api.example.com/v1"
        /></el-form-item>
        <el-form-item v-if="apiForm.kind === 'openai'" label="模型标识"
          ><el-input
            v-model="apiForm.model"
            placeholder="填写平台提供的准确模型名称"
            maxlength="150"
        /></el-form-item>
        <el-form-item v-else label="接口路径"
          ><el-input
            v-model="apiForm.endpointPath"
            placeholder="/reports（不含查询参数或凭据）"
        /></el-form-item>
        <el-form-item
          v-if="apiForm.kind === 'rest'"
          label="HTTP 方法（只登记，不自动执行）"
          ><el-select v-model="apiForm.method"
            ><el-option
              v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']"
              :key="method"
              :label="method"
              :value="method" /></el-select
        ></el-form-item>
        <div class="form-pair">
          <el-form-item label="认证方式"
            ><el-select v-model="apiForm.auth"
              ><el-option label="Bearer Token" value="bearer" /><el-option
                label="自定义密钥请求头"
                value="header" /><el-option
                v-if="apiForm.kind === 'rest'"
                label="无需认证"
                value="none" /></el-select></el-form-item
          ><el-form-item v-if="apiForm.auth === 'header'" label="认证请求头名称"
            ><el-input v-model="apiForm.header" placeholder="X-API-Key"
          /></el-form-item>
        </div>
        <el-form-item
          v-if="apiForm.auth !== 'none'"
          :label="
            apiForm.secretConfigured ? '替换密钥（留空保留）' : '认证密钥'
          "
          ><el-input
            v-model="apiForm.secret"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="仅填写新密钥，不填写星号占位值"
            maxlength="8000"
        /></el-form-item>
        <el-form-item label="API 状态"
          ><el-switch
            v-model="apiForm.enabled"
            active-text="启用"
            inactive-text="停用"
        /></el-form-item>
      </el-form>
      <template #footer
        ><el-button @click="apiDialog = false">取消</el-button
        ><el-button type="primary" :loading="busy" @click="saveApi"
          >保存 API</el-button
        ></template
      >
    </el-dialog>
  </section>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { getApiRegistry, mutateApiRegistry } from "@/api";
const emit = defineEmits(["changed"]);
const loading = ref(false),
  busy = ref(false),
  selected = ref(""),
  notice = ref(""),
  noticeType = ref("info");
const state = reactive({
  revision: 0,
  platforms: [],
  apis: [],
  audit: [],
  legacyCount: 0,
  legacyProfiles: [],
});
const binding = reactive({ aiEnabled: false, activeAiProfileId: "" });
const platformDialog = ref(false),
  apiDialog = ref(false),
  platformForm = reactive({}),
  apiForm = reactive({});
const currentPlatform = computed(() =>
  state.platforms.find((p) => p.id === selected.value),
);
const filtered = computed(() =>
  state.apis.filter((a) => !selected.value || a.platformId === selected.value),
);
const models = computed(() =>
  state.apis.filter(
    (a) => a.kind === "openai" && a.enabled && platformEnabled(a.platformId),
  ),
);
const platformName = (id) =>
  state.platforms.find((p) => p.id === id)?.name || "未找到平台";
const platformEnabled = (id) =>
  !!state.platforms.find((p) => p.id === id)?.enabled;
const count = (id) => state.apis.filter((a) => a.platformId === id).length;
function apply(data) {
  Object.assign(state, data);
  Object.assign(binding, {
    aiEnabled: data.aiEnabled,
    activeAiProfileId: data.activeAiProfileId,
  });
}
async function load() {
  notice.value = "";
  loading.value = true;
  try {
    apply(await getApiRegistry());
  } catch (e) {
    noticeType.value = "error";
    notice.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function change(method, path, data) {
  busy.value = true;
  try {
    const result = await mutateApiRegistry(method, path, {
      ...data,
      revision: state.revision,
    });
    apply(result);
    emit("changed");
    noticeType.value = "success";
    notice.value = "配置已保存";
    return true;
  } catch (e) {
    noticeType.value = "error";
    notice.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}
function clearPlatform() {
  Object.keys(platformForm).forEach((k) => delete platformForm[k]);
}
function clearApi() {
  Object.keys(apiForm).forEach((k) => delete apiForm[k]);
}
function editPlatform(p) {
  notice.value = "";
  clearPlatform();
  Object.assign(
    platformForm,
    p || { name: "", description: "", enabled: true },
  );
  platformDialog.value = true;
}
function editApi(a) {
  notice.value = "";
  clearApi();
  Object.assign(
    apiForm,
    a
      ? { ...a, method: a.method || "GET", secret: "" }
      : {
          platformId: selected.value || state.platforms[0]?.id,
          name: "",
          kind: "openai",
          baseUrl: "",
          model: "",
          auth: "bearer",
          header: "",
          endpointPath: "/",
          method: "GET",
          secret: "",
          enabled: true,
        },
  );
  apiDialog.value = true;
}
async function confirm(message) {
  try {
    await ElMessageBox.confirm(message, "确认操作", {
      type: "warning",
      confirmButtonText: "确认",
      cancelButtonText: "取消",
    });
    return true;
  } catch {
    return false;
  }
}
async function savePlatform() {
  if (
    await change(
      platformForm.id ? "put" : "post",
      `/platforms${platformForm.id ? "/" + platformForm.id : ""}`,
      platformForm,
    )
  )
    platformDialog.value = false;
}
async function saveApi() {
  const old = state.apis.find((a) => a.id === apiForm.id);
  if (
    old?.references.includes("机器人当前模型") &&
    !(await confirm("此API正在被机器人使用，保存会影响下一次调用。确认修改？"))
  )
    return;
  if (
    await change(
      apiForm.id ? "put" : "post",
      `/apis${apiForm.id ? "/" + apiForm.id : ""}`,
      apiForm,
    )
  ) {
    apiForm.secret = "";
    apiDialog.value = false;
  }
}
async function removePlatform(p) {
  if (await confirm(`删除平台“${p.name}”？平台下有API时将不能删除。`)) {
    if (await change("delete", `/platforms/${p.id}`, {})) selected.value = "";
  }
}
async function removeApi(a) {
  if (await confirm(`删除API“${a.name}”及其加密凭据？历史分析结果保留。`))
    await change("delete", `/apis/${a.id}`, {});
}
async function migrate() {
  if (
    await confirm(
      "将旧模型凭据迁移到加密存储并清除原明文配置，当前模型编号保持不变。确认迁移？",
    )
  )
    await change("post", "/migrate", {});
}
async function saveBinding() {
  if (
    await confirm(
      "保存后下一次机器人问答使用此模型引用；启用外部模型后，相关聚合经营数据会发送给所选平台。",
    )
  )
    await change("put", "/binding", binding);
}
async function test(a) {
  if (
    !(await confirm(
      "将发送一条“Reply OK.”验证模型协议，可能产生少量API费用，不包含经营数据，也不会发送群消息。",
    ))
  )
    return;
  busy.value = true;
  try {
    const result = await mutateApiRegistry("post", `/apis/${a.id}/test`, {
      revision: state.revision,
    });
    await load();
    notice.value = `${result.message}（HTTP ${result.status}，${result.elapsedMs}ms）`;
    noticeType.value = result.ok ? "success" : "warning";
  } catch (e) {
    notice.value = e.message;
    noticeType.value = "error";
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<style scoped>
.registry {
  padding: 24px;
  background: #fff;
  border: 1px solid #e2e8f2;
  border-radius: 14px;
  margin-top: 16px;
  color: #223858;
}
.registry-head,
.api-toolbar,
.binding {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.registry h2,
.registry h3 {
  margin: 0 0 10px;
}
.registry h2 {
  font-size: 19px;
}
.registry h3 {
  font-size: 15px;
}
.registry p {
  font-size: 12px;
  color: #71829b;
  line-height: 1.7;
  margin: 0 0 14px;
}
.registry-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  margin-top: 24px;
}
.platform-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.platform-list button {
  border: 1px solid transparent;
  background: #f5f7fb;
  border-radius: 8px;
  padding: 12px 16px;
  min-width: 160px;
  text-align: left;
  color: #304e77;
  cursor: pointer;
}
.platform-list button.selected {
  background: #eaf1ff;
  border-color: #bcd0ff;
  color: #245fe5;
}
.platform-list b,
.platform-list span {
  display: block;
}
.platform-list span {
  font-size: 12px;
  margin-top: 8px;
  color: #7b8ca8;
}
.api-toolbar > div:last-child {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.api-toolbar .el-button {
  margin-left: 0;
}
.api-list {
  min-width: 0;
}
small {
  display: block;
  color: #7a8aa2;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.endpoint {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.help {
  margin-top: 14px !important;
}
.binding {
  border-top: 1px solid #e7edf5;
  padding-top: 22px;
  margin-top: 24px;
}
.binding-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.binding-controls .el-select {
  width: 260px;
}
.legacy {
  margin-top: 16px;
}
.audit {
  margin-top: 24px;
}
.api-form {
  margin-top: 20px;
}
.form-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.registry :deep(.el-select) {
  width: 100%;
}
.binding-controls :deep(.el-select) {
  width: 260px;
}
.platform-list button:focus-visible {
  outline: 2px solid #245fe5;
  outline-offset: 2px;
}
@media (max-width: 1100px) {
  .registry-body {
    grid-template-columns: 1fr;
  }
  .binding {
    flex-direction: column;
  }
  .api-toolbar {
    flex-direction: column;
  }
}
@media (max-width: 680px) {
  .registry {
    padding: 16px;
  }
  .registry-body {
    grid-template-columns: 1fr;
  }
  .platform-list {
    flex-direction: row;
    overflow-x: auto;
  }
  .platform-list button {
    min-width: 140px;
  }
  .registry-head {
    flex-direction: column;
  }
  .form-pair {
    grid-template-columns: 1fr;
  }
}
</style>
