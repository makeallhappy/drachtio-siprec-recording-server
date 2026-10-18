<template>
  <el-container class="layout">
    <el-header class="header">
      <span class="brand">SIPREC 录音查询</span>
      <div class="right" v-if="auth.isAuthenticated">
        <span class="user">{{ displayName }}</span>
        <el-button text class="logout" @click="onLogout">退出</el-button>
      </div>
    </el-header>
    <el-main class="main">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '@/auth'

const router = useRouter()
const displayName = computed(() => {
  const u = auth.user
  if (!u) return ''
  const name = [u.firstname, u.lastname].filter(Boolean).join(' ')
  return name || u.loginString || ''
})

function onLogout() {
  auth.logout()
  router.push('/login')
}
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; }
.layout { min-height: 100vh; }
.header { background: #001529; color: #fff; display: flex; align-items: center; justify-content: space-between; }
.brand { font-size: 18px; font-weight: 600; }
.right { display: flex; align-items: center; gap: 12px; }
.user { font-size: 14px; color: #d0d7de; }
.logout { color: #fff; }
.main { padding: 20px; max-width: 1400px; margin: 0 auto; width: 100%; }
</style>
