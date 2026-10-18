<template>
  <div class="login-page">
    <el-card class="login-card">
      <h2 class="title">SIPREC 录音查询</h2>
      <el-form :model="form" @submit.prevent="onLogin">
        <el-form-item>
          <el-input v-model="form.loginString" placeholder="登录名" size="large" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" size="large"
                    :prefix-icon="Lock" show-password @keyup.enter="onLogin" />
        </el-form-item>
        <el-form-item>
          <div class="captcha-row">
            <el-input v-model="form.captchaCode" placeholder="验证码(算式结果)" size="large"
                      :prefix-icon="Key" @keyup.enter="onLogin" />
            <img v-if="captchaImg" :src="captchaImg" class="captcha-img" title="点击刷新验证码"
                 alt="验证码" @click="loadCaptcha" />
            <div v-else class="captcha-img captcha-loading" @click="loadCaptcha">点击加载</div>
          </div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" size="large" class="btn" :loading="loading" @click="onLogin">
            登 录
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock, Key } from '@element-plus/icons-vue'
import { auth } from '@/auth'
import axios from 'axios'

const router = useRouter()
const route = useRoute()

const form = ref({ loginString: '', password: '', captchaCode: '' })
const loading = ref(false)
const captchaImg = ref('')
const captchaId = ref('')

async function loadCaptcha() {
  form.value.captchaCode = ''
  try {
    // 验证码是公开接口,不带 token,直接用裸 axios
    const { data } = await axios.get('/api/captcha')
    captchaId.value = data.captchaId
    captchaImg.value = data.imageBase64
  } catch {
    ElMessage.error('验证码加载失败,点击图片重试')
    captchaImg.value = ''
  }
}

onMounted(loadCaptcha)

async function onLogin() {
  if (!form.value.loginString || !form.value.password) {
    ElMessage.warning('请输入登录名和密码')
    return
  }
  if (!form.value.captchaCode) {
    ElMessage.warning('请输入验证码')
    return
  }
  loading.value = true
  try {
    await auth.login(form.value.loginString, form.value.password, captchaId.value, form.value.captchaCode)
    ElMessage.success('登录成功')
    router.push(route.query.redirect || '/')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '登录失败,请检查服务')
    loadCaptcha()  // 失败后刷新验证码(一次性已失效)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page { height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
.login-card { width: 400px; }
.title { text-align: center; margin: 0 0 24px; color: #333; }
.btn { width: 100%; }
.captcha-row { display: flex; gap: 8px; width: 100%; }
.captcha-row .el-input { flex: 1; }
.captcha-img { width: 130px; height: 40px; cursor: pointer; border-radius: 4px; border: 1px solid #dcdfe6; flex-shrink: 0; }
.captcha-loading { display: flex; align-items: center; justify-content: center; font-size: 12px; color: #909399; background: #f5f7fa; }
</style>
