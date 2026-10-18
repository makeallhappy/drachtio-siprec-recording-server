<template>
  <div>
    <el-card>
      <template #header>
        <div class="head">
          <el-button :icon="Back" text @click="$router.push('/recordings')">返回列表</el-button>
          <span class="title">录音详情</span>
          <div class="ops">
            <el-button type="primary" :icon="VideoPlay" :loading="playLoading" @click="onPlay">播放</el-button>
            <el-button :icon="Download" @click="onDownload">下载</el-button>
          </div>
        </div>
      </template>

      <!-- 本页播放条(点播放时生成,双轨波形) -->
      <div v-if="playVisible" class="player-bar">
        <WavePlayer v-if="playUrl" :url="playUrl" :format="playFormat" />
        <el-button text type="info" @click="closePlay">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>

      <el-descriptions v-if="row" :column="2" border>
        <el-descriptions-item label="开始时间">{{ fmtTime(row.start_time) }}</el-descriptions-item>
        <el-descriptions-item label="结束时间">{{ fmtTime(row.end_time) || '—' }}</el-descriptions-item>
        <el-descriptions-item label="时长">{{ fmtDuration(row.duration_ms) }}</el-descriptions-item>
        <el-descriptions-item label="来源表">{{ row.src_table || table }}</el-descriptions-item>

        <el-descriptions-item label="主叫号码">{{ row.caller_number || '—' }}</el-descriptions-item>
        <el-descriptions-item label="被叫号码">{{ row.callee_number || '—' }}</el-descriptions-item>
        <el-descriptions-item label="主叫姓名">{{ row.caller_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="被叫姓名">{{ row.callee_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="主叫 URI" :span="2">{{ row.caller_aor || '—' }}</el-descriptions-item>
        <el-descriptions-item label="被叫 URI" :span="2">{{ row.callee_aor || '—' }}</el-descriptions-item>

        <el-descriptions-item label="录音会话 ID" :span="2">{{ row.recording_session_id || '—' }}</el-descriptions-item>
        <el-descriptions-item label="原始 Call-ID" :span="2">{{ row.original_call_id || '—' }}</el-descriptions-item>
      </el-descriptions>

      <el-collapse v-if="row && (row.metadata_xml || row.sdp_offer)" class="raw">
        <el-collapse-item v-if="row.metadata_xml" title="SIPREC 元数据 XML" name="xml">
          <pre>{{ row.metadata_xml }}</pre>
        </el-collapse-item>
        <el-collapse-item v-if="row.sdp_offer" title="SDP Offer" name="sdp">
          <pre>{{ row.sdp_offer }}</pre>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Back, Download, VideoPlay, Close } from '@element-plus/icons-vue'
import WavePlayer from '@/components/WavePlayer.vue'
import api from '@/api'

const route = useRoute()
const table = route.params.table
const row = ref(null)

// 本页播放条
const playVisible = ref(false)
const playUrl = ref('')
const playFormat = ref('')
const playLoading = ref(false)

async function fetchAudioBlob(fmt) {
  const { data } = await api.get(`/api/recordings/${route.params.table}/${route.params.id}/audio`, {
    params: { fmt },
    responseType: 'blob',
  })
  return URL.createObjectURL(data)
}

async function onPlay() {
  playLoading.value = true
  try {
    if (playUrl.value) URL.revokeObjectURL(playUrl.value)
    playUrl.value = await fetchAudioBlob('flac')
    playFormat.value = 'flac'
    playVisible.value = true
  } catch (e) {
    ElMessage.error('获取音频失败: ' + (e.response?.data?.error || e.message))
  } finally {
    playLoading.value = false
  }
}

async function onDownload() {
  try {
    const url = await fetchAudioBlob('flac')
    const a = document.createElement('a')
    a.href = url
    a.download = `siprec_${row.value?.caller_number || 'x'}_${row.value?.callee_number || 'x'}_${route.params.id}.flac`
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

onMounted(async () => {
  try {
    const { data } = await api.get(`/api/recordings/${route.params.table}/${route.params.id}`)
    data.src_table = route.params.table
    row.value = data
  } catch (e) {
    ElMessage.error('加载失败: ' + (e.response?.data?.error || e.message))
  }
})
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 16px; }
.title { font-size: 16px; font-weight: 600; flex: 1; }
.raw { margin-top: 20px; }
pre { background: #f5f7fa; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.player-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding: 12px 16px; background: #ecf5ff; border: 1px solid #b3d8ff; border-radius: 4px; }
.player { flex: 1; height: 36px; }
</style>
