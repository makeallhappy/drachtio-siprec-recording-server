<template>
  <!-- 登录页:全屏,无边栏 -->
  <router-view v-if="isLoginPage" />

  <!-- 登录后:左侧边栏布局 -->
  <el-container v-else class="layout">
    <el-aside width="210px" class="aside">
      <div class="brand">SIPREC</div>
      <el-menu :default-active="$route.path" class="menu" background-color="#d9ecff"
               text-color="#303133" active-text-color="#0960bd" router>
        <el-menu-item index="/dashboard">
          <el-icon><DataLine /></el-icon><span>概况</span>
        </el-menu-item>
        <el-menu-item index="/recordings">
          <el-icon><Headset /></el-icon><span>录音查询</span>
        </el-menu-item>
        <el-menu-item index="/users">
          <el-icon><User /></el-icon><span>用户管理</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="right" v-if="auth.isAuthenticated">
          <span class="user">{{ displayName }}</span>
          <el-button text class="logout" @click="onLogout">退出</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Headset, User, DataLine } from '@element-plus/icons-vue'
import { auth } from '@/auth'

const route = useRoute()
const router = useRouter()
const isLoginPage = computed(() => route.path === '/login')

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
body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", "PingFang SC", "Helvetica Neue", Arial, sans-serif; background: #f5f7fa; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.layout { min-height: 100vh; }

/* 左侧边栏 */
.aside { background: #d9ecff; min-height: 100vh; }
.brand { color: #0960bd; font-size: 17px; font-weight: 600; padding: 18px 20px; border-bottom: 1px solid #0960bd22; }
.menu { border-right: none; }
.menu :deep(.el-menu-item:hover) { background-color: #c6e2ff; }
.menu :deep(.el-menu-item.is-active) { background-color: #b3d8ff; }

/* 顶栏 */
.header { background: #fff; border-bottom: 1px solid #e4e7ed; display: flex; align-items: center; justify-content: flex-end; padding: 0 20px; }
.right { display: flex; align-items: center; gap: 12px; }
.user { font-size: 14px; color: #606266; }
.logout { color: #409eff; }

.main { padding: 20px; }
</style>
