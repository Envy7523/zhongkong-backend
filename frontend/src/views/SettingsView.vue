<template>
  <div>
    <div class="card-compact">
      <div class="card-header">⚡ 网页设置</div>
      <p style="color:#666;">更多设置项将在后续版本中添加。</p>
    </div>
    <div class="card-compact">
      <div class="card-header">关于</div>
      <div style="color:#666;line-height:1.8;">
        <p><strong>鹅太公中控后台 v0.4.0</strong></p>
        <p>前端：Vue 3 + Element Plus + ECharts + 高德地图 · 后端：Node.js + Express 5 + SQLite</p>
        <p style="margin-top:8px;">启动方式：<code>node server.js</code> 启动后端（端口 3456），<code>cd frontend &amp;&amp; npx vite --host</code> 启动前端（端口 5173），访问 <code>http://localhost:5173</code></p>
        <p style="margin-top:4px;font-size:12px;color:#999;">默认登录：admin / admin123</p>
      </div>
    </div>
  </div>
</template>
