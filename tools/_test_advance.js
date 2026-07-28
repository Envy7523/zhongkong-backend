const http = require('http');
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiLnrqHnkIblkZgiLCJkaXNwbGF5X25hbWUiOiLns7vnu5_nrqHnkIblkZgiLCJhdmF0YXJfdXJsIjoiIiwiaWF0IjoxNzg1MTQ5ODY1LCJleHAiOjE3ODUyMzYyNjV9.cU--7hqqqgv9gSGhebSrfHBeTzPQNbIjVRChHU2x2Y4';
const body = JSON.stringify({ status: '进行中', note: 'API测试推进' });

const req = http.request({
  hostname: 'localhost', port: 3456,
  path: '/api/collab/issues/5/advance',
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  let data = '';
  res.on('data', c => data += c.toString());
  res.on('end', () => console.log(res.statusCode + ' | ' + data));
});
req.write(body);
req.end();
