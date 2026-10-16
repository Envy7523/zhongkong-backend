import assert from 'node:assert/strict';
import {cropGeometry} from '../frontend/src/utils/avatar-crop.mjs';
const wide=cropGeometry(800,400);assert.deepEqual([wide.sx,wide.sy,wide.size],[200,0,400]);
const tall=cropGeometry(400,800);assert.deepEqual([tall.sx,tall.sy,tall.size],[0,200,400]);
const zoomed=cropGeometry(800,400,2);assert.deepEqual([zoomed.sx,zoomed.sy,zoomed.size],[300,100,200]);
for(const [width,height] of [[800,400],[400,800],[1,1],[512,512],[6016,4016]]){
 for(const zoom of [0,1,1.01,2,4,8])for(const x of [-100000,-16,0,16,100000])for(const y of [-100000,0,100000]){
  const g=cropGeometry(width,height,zoom,x,y);
  assert(g.size>0&&g.sx>=-1e-8&&g.sy>=-1e-8);
  assert(g.sx+g.size<=width+1e-8&&g.sy+g.size<=height+1e-8,'drag must never expose an empty border');
  assert.deepEqual(cropGeometry(width,height,zoom,g.panX,g.panY),g,'repeated redraw must keep the same crop');
 }
}
assert.throws(()=>cropGeometry(0,100));assert.throws(()=>cropGeometry(NaN,100));
console.log('PASS avatar crop: centered landscape/portrait, zoom, tiny/large images, drag bounds and redraw stability');
