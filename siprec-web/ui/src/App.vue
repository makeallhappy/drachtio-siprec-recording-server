<template>
  <el-container class="layout">
    <el-header class="header">
      <span class="brand">SIPREC 录音查询</span>
    </el-header>
    <el-main class="main">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup>
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; }
.layout { min-height: 100vh; }
.header { background: #001529; color: #fff; display: flex; align-items: center; }
.brand { font-size: 18px; font-weight: 600; }
.main { padding: 20px; max-width: 1400px; margin: 0 auto; width: 100%; }
</style>
