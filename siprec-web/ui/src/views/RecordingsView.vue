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
        <el-form-item label="通话时长">
          <el-select v-model="query.durationOp" style="width: 90px">
            <el-option label="大于" value="gt" />
            <el-option label="小于" value="lt" />
            <el-option label="等于" value="eq" />
          </el-select>
          <el-input-number
            v-model="query.duration"
            :min="0"
            :precision="0"
            :controls="false"
            placeholder="秒"
            style="width: 100px; margin-left: 8px"
          />
          <span class="unit-tip">秒</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="onSearch">查询</el-button>
          <el-button :icon="Refresh" @click="onReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 常驻播放条(查询条件框下方,双轨波形) -->
    <el-card class="player-card" shadow="never">
      <div class="player-bar">
        <span class="play-title" :title="playTitle">{{ playTitle || '未播放' }}</span>
        <el-button text type="info" class="close-btn" @click="closePlay">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
      <WavePlayer v-if="playUrl" :url="playUrl" :format="playFormat" />
      <div v-else class="empty-player">点录音条目的「播放」听双轨波形</div>
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Refresh, Close } from '@element-plus/icons-vue'
import WavePlayer from '@/components/WavePlayer.vue'
import api from '@/api'

const router = useRouter()
const rows = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const loading = ref(false)
const timeRange = ref(null)
const query = ref({ caller: '', callee: '', durationOp: 'gt', duration: null })

// 播放弹窗
const playVisible = ref(false)
const playUrl = ref('')
const playFormat = ref('')
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
    playFormat.value = 'wav'
    // 等 WavePlayer 组件挂载后自动加载
    setTimeout(() => {
      const ws = document.querySelector('.waveform')
      if (ws) ws.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 100)
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
    // 发 ISO 8601(带本地时区偏移),避免时间戳在不同浏览器时区下的歧义
    if (timeRange.value && timeRange.value[0]) params.startTime = new Date(timeRange.value[0]).toISOString()
    if (timeRange.value && timeRange.value[1]) params.endTime = new Date(timeRange.value[1]).toISOString()
    if (query.value.duration !== null && query.value.duration !== undefined && query.value.duration !== '') {
      params.durationOp = query.value.durationOp
      params.duration = query.value.duration
    }
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
function onReset() {
  query.value = { caller: '', callee: '', durationOp: 'gt', duration: null }
  timeRange.value = null
  page.value = 1
  load()
}
function onRowClick(row) { router.push(`/recordings/${row.src_table}/${row.id}`) }
onMounted(load)
</script>

<style scoped>
.search-card { margin-bottom: 16px; }
.pagination { margin-top: 16px; justify-content: flex-end; }
.unit-tip { margin-left: 6px; font-size: 13px; color: #909399; }
.player-card { margin-bottom: 16px; border-color: #b3d8ff; background: #ecf5ff; }
.player-bar { display: flex; align-items: center; gap: 16px; }
.play-title { font-size: 14px; color: #303133; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.player { flex: 1; height: 36px; }
.close-btn { flex-shrink: 0; }
</style>
