<template>
  <div>
    <el-card>
      <template #header>
        <div class="head">
          <span class="title">用户管理</span>
          <div>
            <el-checkbox v-model="includeDeleted" label="显示已删除" @change="load" style="margin-right: 16px" />
            <el-button type="primary" :icon="Plus" @click="onCreate">新建用户</el-button>
          </div>
        </div>
      </template>

      <el-table :data="rows" v-loading="loading" stripe style="width: 100%">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="firstname" label="名" width="130" />
        <el-table-column prop="lastname" label="姓" width="130" />
        <el-table-column prop="email" label="邮箱" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.deleted" type="info" size="small">已删除</el-tag>
            <el-tag v-else-if="row.disabled" type="danger" size="small">已禁用</el-tag>
            <el-tag v-else type="success" size="small">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ fmtTime(row.dateCreated) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="onEdit(row)">编辑</el-button>
            <el-popconfirm title="确定删除该用户?(软删除)" @confirm="onDelete(row)">
              <template #reference>
                <el-button size="small" text type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无用户" /></template>
      </el-table>
    </el-card>

    <!-- 新建/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑用户' : '新建用户'" width="440px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="名" required>
          <el-input v-model="form.firstname" />
        </el-form-item>
        <el-form-item label="姓">
          <el-input v-model="form.lastname" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.email" />
        </el-form-item>
        <el-form-item v-if="!isEdit" label="登录名">
          <el-input v-model="form.loginString" placeholder="留空默认同「名」" />
        </el-form-item>
        <el-form-item :label="isEdit ? '新密码' : '密码'" :required="!isEdit">
          <el-input v-model="form.password" type="password" show-password
                    :placeholder="isEdit ? '留空不修改' : ''" />
        </el-form-item>
        <el-form-item v-if="isEdit" label="禁用">
          <el-switch v-model="form.disabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api'

const rows = ref([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const isEdit = ref(false)
const editId = ref(null)
const includeDeleted = ref(false)
const form = ref({ firstname: '', lastname: '', email: '', password: '', loginString: '', disabled: false })

function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/api/users', { params: { includeDeleted: includeDeleted.value } })
    rows.value = data
  } catch (e) {
    ElMessage.error('加载失败: ' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
  }
}

function onCreate() {
  isEdit.value = false
  editId.value = null
  form.value = { firstname: '', lastname: '', email: '', password: '', loginString: '', disabled: false }
  dialogVisible.value = true
}

function onEdit(row) {
  isEdit.value = true
  editId.value = row.id
  form.value = {
    firstname: row.firstname, lastname: row.lastname, email: row.email,
    password: '', loginString: '', disabled: row.disabled,
  }
  dialogVisible.value = true
}

async function onSave() {
  if (!form.value.firstname) { ElMessage.warning('名必填'); return }
  if (!isEdit.value && !form.value.password) { ElMessage.warning('密码必填'); return }
  saving.value = true
  try {
    const body = {
      firstname: form.value.firstname,
      lastname: form.value.lastname,
      email: form.value.email,
      password: form.value.password || undefined,
      loginString: form.value.loginString || undefined,
      disabled: form.value.disabled,
    }
    if (isEdit.value) {
      await api.put(`/api/users/${editId.value}`, body)
      ElMessage.success('已更新')
    } else {
      await api.post('/api/users', body)
      ElMessage.success('已创建')
    }
    dialogVisible.value = false
    load()
  } catch (e) {
    ElMessage.error('保存失败: ' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

async function onDelete(row) {
  try {
    await api.delete(`/api/users/${row.id}`)
    ElMessage.success('已删除')
    load()
  } catch (e) {
    ElMessage.error('删除失败: ' + (e.response?.data?.error || e.message))
  }
}

onMounted(load)
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-size: 16px; font-weight: 600; }
</style>
