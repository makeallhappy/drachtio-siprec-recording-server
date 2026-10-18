<template>
  <!-- 登录页:全屏,无边栏 -->
  <router-view v-if="isLoginPage" />

  <!-- 登录后:左侧边栏布局 -->
  <el-container v-else class="layout">
    <el-aside width="210px" class="aside">
      <div class="brand">SIPREC 录音查询</div>
      <el-menu :default-active="$route.path" class="menu" background-color="#001529"
               text-color="#d0d7de" active-text-color="#fff" router>
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
import { Headset, User } from '@element-plus/icons-vue'
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
body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; }
.layout { min-height: 100vh; }

/* 左侧边栏 */
.aside { background: #001529; min-height: 100vh; }
.brand { color: #fff; font-size: 17px; font-weight: 600; padding: 18px 20px; border-bottom: 1px solid #ffffff1a; }
.menu { border-right: none; }

/* 顶栏 */
.header { background: #fff; border-bottom: 1px solid #e4e7ed; display: flex; align-items: center; justify-content: flex-end; padding: 0 20px; }
.right { display: flex; align-items: center; gap: 12px; }
.user { font-size: 14px; color: #606266; }
.logout { color: #409eff; }

.main { padding: 20px; }
</style>
