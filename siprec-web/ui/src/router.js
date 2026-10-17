import { createRouter, createWebHistory } from 'vue-router'
import RecordingsView from '@/views/RecordingsView.vue'
import RecordingDetailView from '@/views/RecordingDetailView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/recordings' },
    { path: '/recordings', name: 'recordings', component: RecordingsView },
    { path: '/recordings/:table/:id', name: 'detail', component: RecordingDetailView, props: true },
  ],
})
