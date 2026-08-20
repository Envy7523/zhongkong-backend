<template>
  <section class="bookkeeping-hero">
    <div class="bookkeeping-hero-copy">
      <span class="bookkeeping-eyebrow">BOOKKEEPING</span>
      <h2>记账本</h2>
      <p>门店日常收支记录，分类管理，按日汇总。</p>
    </div>
    <nav class="bookkeeping-nav">
      <button :class="{ active: active === 'entry' }" @click="navigate('entry')">门店记账</button>
      <button v-if="isAdmin" :class="{ active: active === 'categories' }" @click="navigate('categories')">记账分类</button>
      <button :class="{ active: active === 'records' }" @click="navigate('records')">门店账本</button>
    </nav>
  </section>
</template>

<script setup>
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'

defineProps({ active: { type: String, required: true } })

const auth = useAuthStore()
const app = useAppStore()
const isAdmin = auth.isAdmin

function navigate(tab) {
  app.openTabFromId(`bookkeeping-${tab}`)
}
</script>

<style scoped>
.bookkeeping-hero {
  background: linear-gradient(112deg, #1a3a5c, #2c5f8a 64%, #4a90c4);
  border-radius: 14px;
  padding: 20px 28px;
  margin-bottom: 20px;
  color: #fff;
  box-shadow: 0 8px 20px rgba(20,60,100,.14);
}
.bookkeeping-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .14em;
  color: #a8c8e8;
  text-transform: uppercase;
}
.bookkeeping-hero-copy h2 { margin: 4px 0; font-size: 22px; }
.bookkeeping-hero-copy p { margin: 0; color: #c8ddf5; font-size: 13px; }
.bookkeeping-nav {
  display: flex;
  gap: 4px;
  margin-top: 14px;
}
.bookkeeping-nav button {
  padding: 7px 18px;
  border: 1px solid rgba(255,255,255,.25);
  border-radius: 20px;
  background: transparent;
  color: #c8ddf5;
  font-size: 13px;
  cursor: pointer;
  transition: all .15s;
}
.bookkeeping-nav button:hover { border-color: rgba(255,255,255,.5); color: #fff; }
.bookkeeping-nav button.active { background: #fff; color: #1a3a5c; border-color: #fff; font-weight: 600; }
</style>
