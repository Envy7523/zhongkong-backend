<template>
  <div class="month-grid"><div v-for="label in ['一','二','三','四','五','六','日']" :key="label" class="weekday">{{ label }}</div><div v-for="i in offset" :key="'blank'+i" class="blank" /><button v-for="day in days" :key="day.date" type="button" :class="['day',day.type || day.status,{today:day.date===today,selected:day.date===selected}]" :aria-label="day.date" :disabled="!editable && !selectable" @click="$emit('select',day)"><b>{{ Number(day.date.slice(8)) }}</b><slot :day="day" /></button></div>
</template>
<script setup>
import { computed } from 'vue'
const props=defineProps({period:String,days:{type:Array,default:()=>[]},editable:Boolean,selectable:Boolean,selected:String})
defineEmits(['select'])
const offset=computed(()=>props.period?(new Date(`${props.period}-01T12:00:00+08:00`).getUTCDay()+6)%7:0)
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())
</script>
<style scoped>
.month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.weekday{font-size:12px;text-align:center;color:#64748b;padding:4px}.day{display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-height:70px;padding:9px;border:1px solid #e2e8f0;border-radius:7px;background:#fff;text-align:left;color:#334155;font-family:inherit;min-width:0}.day:not(:disabled){cursor:pointer}.day:not(:disabled):hover{border-color:#93b8ee}.day:disabled{opacity:1}.day.work,.day.attended{background:#eff6ff}.day.rest,.day.holiday{background:#f0fdf4}.day.selected{outline:2px solid #409eff}.day.today b{color:#2563eb}.day b{font-size:13px}.blank{min-height:70px}@media(max-width:600px){.day{min-height:62px;padding:6px 3px;gap:4px}.month-grid{gap:3px}}
</style>
