<template>
  <div>
    <el-card class="search-card">
      <el-form :inline="true" :model="query">
        <el-form-item label="主叫">
          <el-input v-model="query.caller" placeholder="号码 / URI / 姓名" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="被叫">
          <el-input v-model="query.callee" placeholder="号码 / URI / 姓名" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="timeRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            style="width: 360px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="onSearch">查询</el-button>
          <el-button :icon="Refresh" @click="onReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table :data="rows" v-loading="loading" stripe @row-click="onRowClick" style="cursor: pointer; width: 100%">
        <el-table-column prop="start_time" label="开始时间" width="180">
          <template #default="{ row }">{{ fmtTime(row.start_time) }}</template>
        </el-table-column>
        <el-table-column prop="caller_number" label="主叫" width="110" />
        <el-table-column prop="callee_number" label="被叫" width="110" />
        <el-table-column label="时长" width="110">
          <template #default="{ row }">{{ fmtDuration(row.duration_ms) }}</template>
        </el-table-column>
        <el-table-column prop="caller_name" label="主叫姓名" width="130" show-overflow-tooltip />
        <el-table-column prop="callee_name" label="被叫姓名" width="130" show-overflow-tooltip />
        <el-table-column prop="recording_session_id" label="录音会话 ID" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click.stop="onPlay(row)">播放</el-button>
            <el-button size="small" text type="primary" @click.stop="onDownload(row)">下载</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无录音记录" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        class="pagination"
        @size-change="load"
        @current-change="load"
      />
    </el-card>

    <!-- 播放弹窗(内嵌 audio,带波形控件) -->
    <el-dialog v-model="playVisible" title="播放录音" width="520px" @close="closePlay">
      <div class="play-title">{{ playTitle }}</div>
      <audio v-if="playUrl" :src="playUrl" controls autoplay class="player"></audio>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Refresh } from '@element-plus/icons-vue'
import api from '@/api'

const router = useRouter()
const rows = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const loading = ref(false)
const timeRange = ref(null)
const query = ref({ caller: '', callee: '' })

// 播放弹窗
const playVisible = ref(false)
const playUrl = ref('')
const playLoading = ref(false)
const playTitle = ref('')

/** 带 JWT 拉音频 blob,返回可播放的对象 URL */
async function fetchAudioBlob(row, fmt) {
  const { data } = await api.get(`/api/recordings/${row.src_table}/${row.id}/audio`, {
    params: { fmt },
    responseType: 'blob',
  })
  return URL.createObjectURL(data)
}

async function onPlay(row) {
  playLoading.value = true
  playTitle.value = `${row.caller_number || ''} → ${row.callee_number || ''} (${fmtTime(row.start_time)})`
  try {
    if (playUrl.value) URL.revokeObjectURL(playUrl.value)
    playUrl.value = await fetchAudioBlob(row, 'wav')
    playVisible.value = true
  } catch (e) {
    ElMessage.error('获取音频失败: ' + (e.response?.data?.error || e.message))
  } finally {
    playLoading.value = false
  }
}

async function onDownload(row) {
  try {
    const url = await fetchAudioBlob(row, 'wav')
    const a = document.createElement('a')
    a.href = url
    a.download = `siprec_${row.caller_number || 'x'}_${row.callee_number || 'x'}_${row.id}.wav`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  } catch (e) {
    ElMessage.error('下载失败: ' + (e.response?.data?.error || e.message))
  }
}

function closePlay() {
  playVisible.value = false
  if (playUrl.value) { URL.revokeObjectURL(playUrl.value); playUrl.value = '' }
}

function fmtTime(t) {
  if (!t) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtDuration(ms) {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`
}

async function load() {
  loading.value = true
  try {
    const params = {
      page: page.value - 1,
      size: size.value,
      caller: query.value.caller || undefined,
      callee: query.value.callee || undefined,
    }
    if (timeRange.value && timeRange.value[0]) params.startTime = new Date(timeRange.value[0]).getTime()
    if (timeRange.value && timeRange.value[1]) params.endTime = new Date(timeRange.value[1]).getTime()
    const { data } = await api.get('/api/recordings', { params })
    rows.value = data.content
    total.value = data.total
  } catch (e) {
    ElMessage.error('查询失败: ' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
  }
}

function onSearch() { page.value = 1; load() }
function onReset() { query.value = { caller: '', callee: '' }; timeRange.value = null; page.value = 1; load() }
function onRowClick(row) { router.push(`/recordings/${row.src_table}/${row.id}`) }
onMounted(load)
</script>

<style scoped>
.search-card { margin-bottom: 16px; }
.pagination { margin-top: 16px; justify-content: flex-end; }
.play-title { margin-bottom: 14px; font-size: 14px; color: #606266; }
.player { width: 100%; }
</style>
