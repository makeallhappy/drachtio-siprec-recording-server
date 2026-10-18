import { createRouter, createWebHistory } from 'vue-router'
import RecordingsView from '@/views/RecordingsView.vue'
import RecordingDetailView from '@/views/RecordingDetailView.vue'
import LoginView from '@/views/LoginView.vue'
import UsersView from '@/views/UsersView.vue'
import { auth } from '@/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/', redirect: '/recordings' },
    { path: '/recordings', name: 'recordings', component: RecordingsView },
    { path: '/recordings/:table/:id', name: 'detail', component: RecordingDetailView, props: true },
    { path: '/users', name: 'users', component: UsersView },
  ],
})

// 路由守卫:未登录跳 /login
router.beforeEach((to) => {
  if (to.path !== '/login' && !auth.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.path === '/login' && auth.isAuthenticated) {
    return { path: '/' }
  }
})

export default router
