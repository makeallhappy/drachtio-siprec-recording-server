import axios from 'axios'
import { auth } from '@/auth'

const api = axios.create({ baseURL: '/', timeout: 15000 })

// 请求拦截:自动带 JWT
api.interceptors.request.use((cfg) => {
  if (auth.accessToken) cfg.headers.Authorization = `Bearer ${auth.accessToken}`
  return cfg
})

// 响应拦截:401 统一登出跳登录
api.interceptors.response.use(
  (resp) => resp,
  (err) => {
    if (err.response && err.response.status === 401 && !err.config.url.includes('/auth/login')) {
      auth.logout()
      if (location.pathname !== '/login') location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api
