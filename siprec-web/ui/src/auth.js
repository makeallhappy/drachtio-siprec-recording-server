import { reactive, computed } from 'vue'
import api from '@/api'

// 简单全局 auth 状态(localStorage 持久化),对应 orekaweb 的 stores/auth
export const auth = reactive({
  accessToken: localStorage.getItem('accessToken') || '',
  user: JSON.parse(localStorage.getItem('user') || 'null'),

  isAuthenticated: computed(() => !!auth.accessToken),

  async login(loginString, password, captchaId, captchaCode) {
    const { data } = await api.post('/api/auth/login', { loginString, password, captchaId, captchaCode })
    auth.accessToken = data.accessToken
    auth.user = data.user
    localStorage.setItem('accessToken', data.accessToken)
    localStorage.setItem('user', JSON.stringify(data.user))
  },

  logout() {
    auth.accessToken = ''
    auth.user = null
    localStorage.removeItem('accessToken')
    localStorage.removeItem('user')
  },
})
