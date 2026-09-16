/**
 * 门店 GLB 离线压缩
 *
 * ## 为什么是离线工具而不是塞进上传接口
 * 服务端只有 6 个依赖，压缩这套（sharp 原生库 + meshoptimizer wasm）有 20 个包 23MB，
 * 而且压缩是低频操作（换个模型才跑一次）。把它绑进上传路径既拖慢接口又破坏项目的依赖精简，
 * 所以做成独立工具，依赖也刻意装在 tools/gltf-optimizer 自己的目录里，不碰根 package.json。
 *
 * ## 关键取舍：哪些步骤需要改前端
 *   不需要改前端：metalRough / dedup / flatten / join / weld / simplify / prune /
 *                 textureCompress / quantize（KHR_mesh_quantization 是 three 原生支持）
 *   需要改前端：meshopt（EXT_meshopt_compression，要在 GLTFLoader 上注册 MeshoptDecoder）
 * 所以 --lossless 一档产出的文件前端零改动即可加载。
 *
 * ## 各步骤在干什么
 *   metalRough        把 KHR_materials_pbrSpecularGlossiness 转成 metallic-roughness。
 *                     **默认不跑**：转换会引入 KHR_materials_ior=1000（F0≈1.0），
 *                     把模型变成半镜面，和环境贴图叠加后惨白不可用，详见下方注释。
 *   dedup             合并重复的 mesh / accessor / 贴图。
 *   flatten           把节点变换烘进几何，3000+ 节点的矩阵乘法就没了，
 *                     也是 join 能生效的前提（必须先 flatten）。
 *   join              合并共用同一材质的 primitive —— 这是降 draw call 的关键一步。
 *   weld              合并逐位相同的顶点。
 *   simplify          减面（**有损**），靠 meshoptimizer。
 *   textureCompress   限制贴图分辨率。默认只缩放不改格式：模型里有 alphaMode=MASK 的材质，
 *                     盲目转 JPEG 会把 alpha 通道抹掉。
 *   quantize / meshopt 顶点量化 / 熵编码压缩。
 *
 * ## 用法
 *   node optimize.js <输入.glb> [输出.glb] [选项]
 *
 * 选项：
 *   --lossless            不做 simplify，也不做 meshopt（产出文件前端零改动即可加载）
 *   --metalrough          显式转换已弃用的 specular-glossiness（⚠️ 会引入 ior=1000，观感会变）
 *   --ratio 0.15          目标保留顶点比例（simplify）
 *   --error 0.001         减面误差上限（占网格半径比例）
 *   --max-texture 1024    贴图最长边上限，0 表示不缩放
 *   --no-texture          完全跳过贴图处理
 *   --meshopt             启用 meshopt 压缩（需前端注册 MeshoptDecoder）
 *   --quiet               只打印最终结果
 *
 * 内存：读入 135MB 模型后常驻约 300MB，建议 `node --max-old-space-size=4096 optimize.js ...`。
 * 注意本工具**只在最后序列化一次**——中途每步都重新序列化会额外吃几份 135MB 的连续内存，
 * 在 16GB 机器上会直接 ArrayBuffer allocation failed。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, flatten, join, weld, simplify, prune, quantize, meshopt, metalRough,
  textureCompress, getBounds,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

// ===== 参数 =====
const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const input = positional[0];
const output = positional[1] || null;
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const QUIET = flag('quiet');
const LOSSLESS = flag('lossless');
const USE_MESHOPT = flag('meshopt');
const NO_TEXTURE = flag('no-texture');
/** 转 KHR_materials_pbrSpecularGlossiness → metallic-roughness。默认关：会引入 ior=1000 把模型变成镜面 */
const METALROUGH = flag('metalrough');
/** 只跳过减面，仍做 quantize：几何拓扑无损，但顶点坐标被量化（three 原生支持 KHR_mesh_quantization） */
const NO_SIMPLIFY = flag('no-simplify');
/** 保住网格实例复用（跳过 flatten+join）：文件更小，但 draw call 不降 */
const KEEP_INSTANCING = flag('keep-instancing');
const RATIO = Number(option('ratio', 0.15));
const ERROR = Number(option('error', 0.001));
const MAX_TEX = Number(option('max-texture', 1024));

if (!input) {
  console.error('用法: node optimize.js <输入.glb> [输出.glb] [--lossless] [--no-simplify] [--meshopt] [--keep-instancing] [--ratio 0.15] [--max-texture 1024]');
  process.exit(1);
}
const outPath = output || path.join(path.dirname(input), `${path.basename(input, '.glb')}.optimized.glb`);

const mb = bytes => `${(bytes / 1048576).toFixed(2)}MB`;
const log = (...args) => { if (!QUIET) console.log(...args); };

/** glTF 分量类型 → 单分量字节数 */
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** glTF 类型 → 分量个数 */
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * accessor 真实字节数。
 * ⚠️ 不要用 `accessor.getElementSize()`：它返回的是**分量个数**不是字节数
 * （VEC3/float32 返回 3，实际是 12 字节），拿它当字节数会把几何体积算小 4 倍。
 */
function accessorBytes(accessor) {
  const componentBytes = COMPONENT_BYTES[accessor.getComponentType()];
  const components = TYPE_COMPONENTS[accessor.getType()];
  if (!componentBytes || !components) return accessor.getArray()?.byteLength || 0;
  return accessor.getCount() * componentBytes * components;
}

/**
 * 统计文档规模。这些数字才是判断"贵不贵"的依据，文件大小只是表象：
 * 4.1M 三角面 / 1639 次 draw call 才是慢的原因，135MB 只是它的结果。
 *
 * 三个口径必须分清楚，混在一起会得出错误结论（我自己前两版都踩了）：
 *   drawCalls / renderedTriangles —— **按节点实例数**，即每帧真实的渲染代价。
 *                                    一个网格被 10 个节点引用就是 10 次 draw call。
 *   bufferBytes                   —— **按唯一 accessor 去重**，即真正占文件的那份数据。
 *                                    一个被复用的网格只占一份。
 *   imageBytes                    —— 贴图字节数。
 * 用"唯一 accessor"当渲染代价会漏掉实例复用的开销；
 * 反过来用"每节点"当 bufferBytes 会把共享网格重复计入、把体积算大好几倍。
 *
 * 关键：**不序列化**。这些都靠对象元数据算，比 `io.writeBinary()` 便宜几个数量级，
 * 所以可以每步都测而不会把 135MB 的连续内存反复分配掉。
 */
function measure(document) {
  const root = document.getRoot();

  // 每帧真实代价：走节点，一个节点算一次
  let drawCalls = 0, renderedTriangles = 0, renderedVertices = 0, meshInstances = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    meshInstances += 1;
    drawCalls += mesh.listPrimitives().length;
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      renderedVertices += position?.getCount() || 0;
      renderedTriangles += indices ? Math.round(indices.getCount() / 3) : Math.round((position?.getCount() || 0) / 3);
    }
  }

  // 真正占文件的那份数据：唯一 accessor 去重
  let bufferBytes = 0;
  for (const accessor of root.listAccessors()) bufferBytes += accessorBytes(accessor);

  let imageBytes = 0;
  for (const texture of root.listTextures()) imageBytes += texture.getImage()?.byteLength || 0;

  const scene = root.getDefaultScene() || root.listScenes()[0];
  const bounds = scene ? getBounds(scene) : null;
  return {
    bytes: 0, // 真实文件大小只有最终结果才有
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    meshInstances,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    drawCalls, renderedTriangles, renderedVertices,
    bufferBytes: Math.round(bufferBytes), imageBytes,
    size: bounds ? bounds.max.map((v, i) => Number((v - bounds.min[i]).toFixed(2))) : [],
    extensionsUsed: root.listExtensionsUsed().map(e => e.extensionName),
  };
}

function statLine(m) {
  return `节点 ${String(m.nodes).padStart(5)} drawCall ${String(m.drawCalls).padStart(5)} 三角面 ${m.renderedTriangles.toLocaleString().padStart(11)} 几何 ${mb(m.bufferBytes).padStart(9)} 贴图 ${mb(m.imageBytes).padStart(9)}`;
}

function reportTable(rows) {
  const label = {
    bytes: '文件大小', bufferBytes: '几何数据（唯一 accessor）', imageBytes: '贴图占用',
    nodes: '节点数', meshes: '网格对象数', meshInstances: '网格实例数（被节点引用的次数）',
    drawCalls: 'draw call 数（每帧真实）', renderedTriangles: '渲染三角面（每帧真实）', renderedVertices: '渲染顶点数（每帧真实）',
    textures: '贴图张数',
  };
  const byteKeys = ['bytes', 'bufferBytes', 'imageBytes'];
  const first = rows[0];
  console.log('');
  console.log('  指标'.padEnd(36) + rows.map(r => r.name.padStart(20)).join(''));
  for (const key of [...byteKeys, 'nodes', 'meshes', 'meshInstances', 'drawCalls', 'renderedTriangles', 'renderedVertices', 'textures']) {
    console.log(`  ${label[key]}`.padEnd(36) + rows.map(r => (
      byteKeys.includes(key) ? mb(r[key]) : r[key].toLocaleString()
    ).padStart(20)).join(''));
    if (key === 'bytes' || key === 'drawCalls' || key === 'renderedTriangles' || key === 'bufferBytes') {
      console.log('  └ 相对压缩前'.padEnd(36) + rows.map(r => (
        r === first || !first[key] ? '—' : `${((1 - r[key] / first[key]) * 100).toFixed(1)}% ↓`
      ).padStart(20)).join(''));
    }
  }
  console.log('');
  for (const row of rows) console.log(`  ${row.name}\n    世界尺寸 ${JSON.stringify(row.size)}\n    扩展 [${row.extensionsUsed.join(', ')}]`);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

log(`读取 ${input}`);
const started = Date.now();
const document = await io.read(input);
const srcBytes = fs.statSync(input).size;
const before = { name: '压缩前', ...measure(document), bytes: srcBytes };
log(`  ${statLine(before)}`);
log('');
log('  步骤                执行后规模');

const steps = [];
async function step(name, fn) {
  const t = Date.now();
  const note = await fn();
  const stats = measure(document);
  steps.push({ name, ms: Date.now() - t, note, stats });
  log(`  ${String(steps.length).padStart(2)}. ${name.padEnd(17)} ${statLine(stats)}  ${typeof note === 'string' ? note : ''}`);
}
const primCount = () => {
  let n = 0;
  for (const mesh of document.getRoot().listMeshes()) n += mesh.listPrimitives().length;
  return n;
};

/**
 * ⚠️ metalRough 默认**不跑**，因为它会毁掉观感（实测踩过）：
 * SimLab 导出的模型把彩色高光放在 KHR_materials_pbrSpecularGlossiness 里，
 * 而 three 0.185 **完全不支持这个扩展**（grep 过源码），渲染时只用 pbrMetallicRoughness
 * 那一套值（如 metallicFactor 0.5 / roughnessFactor 0.5）。
 * metalRough() 按 glTF 规范把 SG 转成 MR：metallicFactor 归 0，
 * 并用 **KHR_materials_ior = 1000** 编码"彩色高光"——F0 = ((1000-1)/(1000+1))² = 0.996，
 * 是物理介质（ior 1.5 → F0 0.04）的 25 倍。实测 117 个材质全部如此，
 * 叠上环境贴图后整个模型惨白反光、无法演示。
 * 要让压缩后的模型和原始模型**渲染一致**，就别动材质。
 * 确实需要转换时用 --metalrough 显式打开，并自行承担观感变化。
 */
if (METALROUGH) {
  await step('metalRough', async () => {
    const used = document.getRoot().listExtensionsUsed().some(e => e.extensionName === 'KHR_materials_pbrSpecularGlossiness');
    await document.transform(metalRough());
    return used ? '⚠️ 已转 specular-glossiness（引入 ior=1000，观感会变）' : '无需转换';
  });
} else {
  log('  --  metalRough        跳过（默认保留原始材质，保证与原始模型渲染一致）');
}
await step('dedup', async () => { await document.transform(dedup()); return '合并重复 mesh/accessor/贴图'; });

/**
 * flatten + join 是**用体积换 draw call**，不是白赚：
 * 原模型靠"多个节点复用同一个网格"省空间（实测 426 个网格被 1639 个节点引用），
 * flatten 把每个实例的变换烘进几何、join 再把它们并成少数几个大网格，
 * 结果是 draw call 大降、但文件里要显式存下每一份实例几何 → 文件变大。
 * 所以做成可选：要传输小就 --keep-instancing，要渲染快就别加。
 */
if (KEEP_INSTANCING) {
  log('  --  flatten/join      跳过（--keep-instancing：保住网格复用，文件更小）');
} else {
  await step('flatten', async () => { await document.transform(flatten()); return '烘平节点变换'; });
  await step('join', async () => {
    const before2 = primCount();
    await document.transform(join({ keepNamed: false }));
    return `draw call ${before2} → ${primCount()}`;
  });
}

await step('weld', async () => { await document.transform(weld()); return '合并重复顶点'; });

if (!LOSSLESS && !NO_SIMPLIFY) {
  await step('simplify', async () => {
    const v0 = measure(document).renderedVertices;
    await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }));
    const v1 = measure(document).renderedVertices;
    return `顶点 ${v0.toLocaleString()} → ${v1.toLocaleString()}（ratio ${RATIO}, error ${ERROR}）`;
  });
} else {
  log(`  --  simplify          跳过（${LOSSLESS ? '--lossless' : '--no-simplify'}）`);
}

if (!NO_TEXTURE && MAX_TEX > 0) {
  await step('textureCompress', async () => {
    // 只缩放不改格式：模型里有 alphaMode=MASK 的材质，转 JPEG 会抹掉 alpha 通道
    await document.transform(textureCompress({ encoder: sharp, resize: [MAX_TEX, MAX_TEX], quality: 85 }));
    return `贴图最长边限制 ${MAX_TEX}px（保持原格式，避免破坏 alpha）`;
  });
} else {
  log('  --  textureCompress   跳过');
}

await step('prune', async () => { await document.transform(prune()); return '清掉无用资源'; });

if (!LOSSLESS && USE_MESHOPT) {
  await step('meshopt', async () => {
    await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    return 'EXT_meshopt_compression（前端需注册 MeshoptDecoder）';
  });
} else if (!LOSSLESS) {
  await step('quantize', async () => { await document.transform(quantize()); return 'KHR_mesh_quantization（three 原生支持）'; });
} else {
  log('  --  quantize/meshopt  跳过（--lossless 要保证前端零改动）');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
await io.write(outPath, document);
const written = fs.statSync(outPath).size;
const after = { name: LOSSLESS ? '优化后（无损档）' : (NO_SIMPLIFY ? '优化后（不减面+量化）' : '优化后（含减面）'), ...measure(document), bytes: written };

console.log('');
console.log('=== 分步耗时 ===');
for (const s of steps) console.log(`  ${s.name.padEnd(18)} ${String(s.ms).padStart(6)}ms`);
console.log('');
console.log('=== 最终对比 ===');
reportTable([before, after]);
console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s   压缩率 ${(srcBytes / written).toFixed(1)}x   节省 ${mb(srcBytes - written)}`);
console.log(`  输出 ${outPath}`);
