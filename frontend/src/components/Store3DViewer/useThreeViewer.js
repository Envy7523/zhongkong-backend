import { computed, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { Timer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
// three 自带 meshopt 解码器（28KB，随打包进 store3d 分包，不新增 npm 依赖）。
// 注册它是为了兜底：tools/gltf-optimizer 带 --meshopt 选项，产物是 EXT_meshopt_compression，
// 若不注册，加载时会失败且错误信息完全看不出原因。
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const VIEW_DIRECTIONS = {
  top: new THREE.Vector3(0, 1, 0),
  front: new THREE.Vector3(0, 0.16, 1),
  left: new THREE.Vector3(-1, 0.16, 0),
  right: new THREE.Vector3(1, 0.16, 0),
}

/** 关键光的原始方向（18,28,20）与辅光（-15,12,-16）：按模型尺寸等比缩放，保证不同大小的模型光照一致 */
const KEY_LIGHT_DIRECTION = new THREE.Vector3(18, 28, 20).normalize()
const FILL_LIGHT_DIRECTION = new THREE.Vector3(-15, 12, -16).normalize()

function disposeMaterial(material) {
  if (!material) return
  Object.values(material).forEach(value => {
    if (value && value.isTexture) value.dispose()
  })
  material.dispose?.()
}

function disposeObject(root) {
  root?.traverse?.(node => {
    if (!node.isMesh) return
    node.geometry?.dispose?.()
    Array.isArray(node.material) ? node.material.forEach(disposeMaterial) : disposeMaterial(node.material)
  })
}

export function useThreeViewer() {
  const loading = ref(true)
  const progress = ref(0)
  const error = ref('')
  const modelInfo = ref(null)
  const isGridVisible = ref(true)
  const isAutoRotate = ref(false)
  const isRoaming = ref(false)
  const isFullscreen = ref(false)
  const renderProfile = ref('day')
  const statusText = computed(() => {
    if (error.value) return '加载失败'
    if (loading.value) return `正在加载模型 ${progress.value}%`
    return isRoaming.value ? '漫游模式' : '模型已就绪'
  })

  let host = null
  let scene = null
  let camera = null
  let renderer = null
  let orbit = null
  let pointer = null
  let grid = null
  let modelRoot = null
  let keyLight = null
  let fillLight = null
  let ambientLight = null
  let rafId = 0
  let resizeObserver = null
  let intersectionObserver = null
  let boundingBox = null
  let timer = null
  let pmrem = null
  let envTexture = null
  let annotationGroup = null
  let annotationItems = []
  const raycaster = new THREE.Raycaster()
  const pointerNdc = new THREE.Vector2()
  const keys = new Set()

  // ===== 按需渲染 =====
  // 原实现是"每帧无条件 render"：静止不动也在 60fps 烧 GPU（笔记本风扇、电池、远程桌面都受影响）。
  // 现在只有真正需要时才画：控件变化、尺寸变化、按键漫游、自动旋转。
  // 一直没人动就把 requestAnimationFrame 循环整个停掉，闲置成本为 0。
  let dirty = true
  let running = false
  let onScreen = true
  let pageVisible = !(typeof document !== 'undefined' && document.hidden)

  function requestRender() {
    dirty = true
    if (running || !onScreen || !pageVisible) return
    running = true
    rafId = requestAnimationFrame(animate)
  }

  function stopLoop() {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    dirty = true // 下次恢复时补一帧
  }

  function updateSize() {
    if (!host || !renderer || !camera) return
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    requestRender()
  }

  function setCamera(distance, direction = VIEW_DIRECTIONS.front) {
    if (!boundingBox || !camera || !orbit) return
    const center = boundingBox.getCenter(new THREE.Vector3())
    const unit = direction.clone().normalize()
    camera.position.copy(center).addScaledVector(unit, distance)
    camera.near = Math.max(0.01, distance / 120)
    camera.far = Math.max(1000, distance * 120)
    camera.updateProjectionMatrix()
    orbit.target.copy(center)
    orbit.update()
    requestRender()
  }

  function frameModel() {
    if (!boundingBox || !camera || !orbit) return
    const size = boundingBox.getSize(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z, 0.01)
    const verticalFov = THREE.MathUtils.degToRad(camera.fov)
    const distance = Math.max(maxDimension / (2 * Math.tan(verticalFov / 2)) * 1.5, maxDimension * 1.5, 2)
    orbit.minDistance = Math.max(maxDimension * 0.04, 0.08)
    orbit.maxDistance = Math.max(maxDimension * 20, 80)
    orbit.maxPolarAngle = Math.PI * 0.495
    setCamera(distance)
  }

  function resetView() { frameModel() }
  function setView(view) {
    if (!boundingBox) return
    const size = boundingBox.getSize(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z, 0.01)
    const distance = Math.max(maxDimension * 1.9, 2)
    setCamera(distance, VIEW_DIRECTIONS[view] || VIEW_DIRECTIONS.front)
  }

  function setGridVisible(value = !isGridVisible.value) {
    isGridVisible.value = Boolean(value)
    if (grid) grid.visible = isGridVisible.value
    requestRender()
  }

  function setAutoRotate(value = !isAutoRotate.value) {
    isAutoRotate.value = Boolean(value)
    if (orbit) orbit.autoRotate = isAutoRotate.value
    requestRender()
  }

  /**
   * 同一份门店模型通过不同光照预设服务不同工作场景：
   * 日间用于看布局，晚间用于检视门头和氛围，巡检模式提高对比度以突出设备与动线。
   * 这是浏览器 GPU 实时渲染，不会把用户上传的 GLB 重写或降质。
   */
  function setRenderProfile(profile = 'day') {
    const next = ['day', 'night', 'inspection'].includes(profile) ? profile : 'day'
    renderProfile.value = next
    if (!scene || !renderer) return
    const settings = {
      day: { background: 0xf4f7fb, exposure: 1.16, environment: 1.08, ambient: 3.35, key: 4.1, fill: 1.8 },
      night: { background: 0x182233, exposure: 0.9, environment: 0.62, ambient: 1.45, key: 2.15, fill: 0.72 },
      inspection: { background: 0xf0f5fa, exposure: 1.3, environment: 1.28, ambient: 3.8, key: 4.65, fill: 2.15 },
    }[next]
    scene.background = new THREE.Color(settings.background)
    scene.environmentIntensity = settings.environment
    renderer.toneMappingExposure = settings.exposure
    if (ambientLight) ambientLight.intensity = settings.ambient
    if (keyLight) keyLight.intensity = settings.key
    if (fillLight) fillLight.intensity = settings.fill
    requestRender()
  }

  function disposeAnnotationGroup() {
    if (!annotationGroup) return
    scene?.remove(annotationGroup)
    disposeObject(annotationGroup)
    annotationGroup = null
  }

  /** 将服务器保存的坐标渲染为轻量热点，不修改原 GLB 的材质或节点。 */
  function setAnnotations(annotations = []) {
    annotationItems = Array.isArray(annotations) ? annotations : []
    if (!scene) return
    disposeAnnotationGroup()
    annotationGroup = new THREE.Group()
    annotationGroup.name = '__store_annotations__'
    annotationItems.forEach(annotation => {
      const color = annotation.status === '已完成' ? 0x25a879 : 0x2c78dc
      const marker = new THREE.Group()
      marker.userData.annotation = annotation
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }))
      stem.position.y = 0.16
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.38, roughness: 0.35 }))
      head.position.y = 0.36
      marker.add(stem, head)
      marker.position.set(Number(annotation.position_x), Number(annotation.position_y), Number(annotation.position_z))
      annotationGroup.add(marker)
    })
    scene.add(annotationGroup)
    requestRender()
  }

  /** 返回点击处的世界坐标、法线与 GLB 节点名，交由页面填写业务资料后再保存。 */
  function pickAt(clientX, clientY) {
    if (!renderer || !camera || !modelRoot) return null
    const rect = renderer.domElement.getBoundingClientRect()
    pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointerNdc, camera)
    const hit = raycaster.intersectObject(modelRoot, true)[0]
    if (!hit) return null
    let node = hit.object
    while (node && !node.name) node = node.parent
    const normal = hit.face?.normal?.clone()?.transformDirection(hit.object.matrixWorld) || new THREE.Vector3(0, 1, 0)
    return {
      node_name: node?.name || hit.object.name || '未命名模型节点',
      position_x: Number(hit.point.x.toFixed(4)), position_y: Number(hit.point.y.toFixed(4)), position_z: Number(hit.point.z.toFixed(4)),
      normal_x: Number(normal.x.toFixed(4)), normal_y: Number(normal.y.toFixed(4)), normal_z: Number(normal.z.toFixed(4)),
    }
  }

  function pickAnnotationAt(clientX, clientY) {
    if (!renderer || !camera || !annotationGroup) return null
    const rect = renderer.domElement.getBoundingClientRect()
    pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointerNdc, camera)
    const hit = raycaster.intersectObject(annotationGroup, true)[0]
    if (!hit) return null
    let node = hit.object
    while (node && !node.userData?.annotation) node = node.parent
    return node?.userData?.annotation || null
  }

  function focusPoint(point) {
    if (!camera || !orbit || !point) return
    const target = new THREE.Vector3(Number(point.position_x), Number(point.position_y), Number(point.position_z))
    const direction = camera.position.clone().sub(orbit.target).normalize()
    const distance = Math.max((modelInfo.value?.maxDimension || 10) * 0.62, 4)
    orbit.target.copy(target)
    camera.position.copy(target).addScaledVector(direction, distance)
    orbit.update()
    requestRender()
  }

  function onKeyDown(event) {
    if (!isRoaming.value) return
    const key = event.key.toLowerCase()
    if (['w', 'a', 's', 'd'].includes(key)) {
      keys.add(key)
      event.preventDefault()
      requestRender()
    }
  }

  function onKeyUp(event) {
    keys.delete(event.key.toLowerCase())
    requestRender()
  }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === renderer?.domElement
    isRoaming.value = locked
    if (orbit) orbit.enabled = !locked
    if (!locked) keys.clear()
    requestRender()
  }

  function enterRoam() {
    if (!pointer || !renderer) return
    orbit.enabled = false
    pointer.lock()
  }

  function exitRoam() {
    if (document.pointerLockElement) document.exitPointerLock()
    isRoaming.value = false
    if (orbit) orbit.enabled = true
    keys.clear()
    requestRender()
  }

  function updateRoam(delta) {
    if (!isRoaming.value || !pointer) return
    const speed = Math.max((modelInfo.value?.maxDimension || 10) * 0.75, 3)
    const movement = speed * Math.min(delta, 0.05)
    if (keys.has('w')) pointer.moveForward(movement)
    if (keys.has('s')) pointer.moveForward(-movement)
    if (keys.has('a')) pointer.moveRight(-movement)
    if (keys.has('d')) pointer.moveRight(movement)
  }

  async function toggleFullscreen() {
    if (!host) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await host.requestFullscreen?.()
  }

  function onFullscreenChange() { isFullscreen.value = document.fullscreenElement === host; setTimeout(updateSize, 80) }

  function onVisibilityChange() {
    pageVisible = !document.hidden
    if (pageVisible) requestRender()
    else stopLoop()
  }

  function animate() {
    // 没人动就彻底停下 RAF 循环：闲置时 CPU/GPU 都不再工作
    if (!dirty) { running = false; rafId = 0; return }
    dirty = false
    timer.update()
    const delta = timer.getDelta()
    if (isRoaming.value && keys.size) updateRoam(delta)
    let moving = false
    if (!isRoaming.value && orbit) moving = orbit.update()
    renderer.render(scene, camera)
    // 阻尼未停 / 自动旋转 / 漫游中按着移动键 → 继续下一帧
    if (moving || isAutoRotate.value || (isRoaming.value && keys.size)) dirty = true
    if (dirty && onScreen && pageVisible) rafId = requestAnimationFrame(animate)
    else { running = false; rafId = 0 }
  }

  /**
   * 把灯光与阴影相机按模型实际尺寸摆好。
   *
   * 原来的问题：DirectionalLight 的阴影相机是 three 默认的 OrthographicCamera(-5,5,5,-5)，
   * 正交视野只有 10×10 单位。实测门店模型是 51×50 —— 阴影只覆盖原点附近一小块，
   * 其余全部被裁掉，等于"代价照付、结果是错的"。
   * 同时光照位置是写死的 (18,28,20)，换成 5 米的小模型会过曝、换成 100 米的大模型会过暗。
   */
  function fitLights() {
    if (!boundingBox || !keyLight || !fillLight) return
    const size = boundingBox.getSize(new THREE.Vector3())
    const center = boundingBox.getCenter(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z, 0.01) * 0.5

    keyLight.position.copy(center).addScaledVector(KEY_LIGHT_DIRECTION, radius * 3)
    keyLight.target.position.copy(center)
    fillLight.position.copy(center).addScaledVector(FILL_LIGHT_DIRECTION, radius * 3)

    /**
     * 阴影正交框要按**包围球半径**给，不能按"最大边长的一半"。
     * 门店模型常是 51×50×10 这种扁平体：最大边长的一半只有 25.7，
     * 而任何光照方向下要装下整个模型，需要的是外接球半径 0.5×√(51²+50²+10²)=36.2。
     * 按最大边长给会漏掉四角 —— 实测阴影 pass 只画到 820/1639 个 mesh，
     * 表现为"部分区域的阴影突然被切掉"。
     */
    const sphere = boundingBox.getBoundingSphere(new THREE.Sphere())
    const shadowCamera = keyLight.shadow.camera
    const half = Math.max(sphere.radius, 0.01) * 1.05
    shadowCamera.left = -half
    shadowCamera.right = half
    shadowCamera.top = half
    shadowCamera.bottom = -half
    shadowCamera.near = Math.max(sphere.radius * 0.02, 0.1)
    shadowCamera.far = sphere.radius * 10
    shadowCamera.updateProjectionMatrix()
    // 72 单位的框配 2048 阴影贴图 → 每纹素约 3.5cm，够看清投影
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.bias = -sphere.radius * 0.0003
    keyLight.shadow.normalBias = sphere.radius * 0.0015
    keyLight.shadow.needsUpdate = true
  }

  function loadModel(url) {
    loading.value = true
    error.value = ''
    progress.value = 0
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    loader.load(url, gltf => {
      if (modelRoot) { scene.remove(modelRoot); disposeObject(modelRoot) }
      modelRoot = gltf.scene
      // 顺便统计模型规模：排查"为什么这个模型卡"时，mesh 数和三角面数是第一手依据
      let meshCount = 0
      let triangleCount = 0
      const maxAnisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1
      modelRoot.traverse(node => {
        if (!node.isMesh) return
        meshCount += 1
        const index = node.geometry?.index
        const position = node.geometry?.attributes?.position
        triangleCount += index ? index.count / 3 : (position?.count || 0) / 3
        node.castShadow = true
        node.receiveShadow = true
        const materials = Array.isArray(node.material) ? node.material : [node.material]
        materials.filter(Boolean).forEach(material => {
          // 远处的地面、招牌和墙面贴图更清楚；不会增加模型下载体积。
          Object.values(material).forEach(texture => {
            if (texture?.isTexture) texture.anisotropy = Math.min(maxAnisotropy, 8)
          })
          if ('envMapIntensity' in material) material.envMapIntensity = 1.12
          material.needsUpdate = true
        })
      })
      console.info('[Store3D] 模型规模', { meshes: meshCount, triangles: Math.round(triangleCount) })
      scene.add(modelRoot)
      boundingBox = new THREE.Box3().setFromObject(modelRoot)
      const size = boundingBox.getSize(new THREE.Vector3())
      const center = boundingBox.getCenter(new THREE.Vector3())
      modelInfo.value = {
        size: { x: Number(size.x.toFixed(3)), y: Number(size.y.toFixed(3)), z: Number(size.z.toFixed(3)) },
        center: { x: Number(center.x.toFixed(3)), y: Number(center.y.toFixed(3)), z: Number(center.z.toFixed(3)) },
        maxDimension: Math.max(size.x, size.y, size.z),
      }
      console.info('[Store3D] GLB bounding box', { box: boundingBox.clone(), size: modelInfo.value.size, center: modelInfo.value.center })
      // 旧网格必须先从场景里摘掉：原来只 dispose 不移除，重复 loadModel 会在场景里堆网格
      if (grid) { scene.remove(grid); grid.geometry?.dispose?.(); grid.material?.dispose?.() }
      const gridSize = Math.max(modelInfo.value.maxDimension * 2.2, 12)
      grid = new THREE.GridHelper(gridSize, 32, 0x8ca7c9, 0xdbe7f3)
      grid.position.y = boundingBox.min.y - Math.max(modelInfo.value.maxDimension * 0.001, 0.01)
      grid.visible = isGridVisible.value
      scene.add(grid)
      fitLights()
      setAnnotations(annotationItems)
      frameModel()
      progress.value = 100
      loading.value = false
      requestRender()
    }, event => {
      progress.value = event.total ? Math.min(99, Math.round(event.loaded / event.total * 100)) : Math.min(95, progress.value + 2)
    }, loadError => {
      console.error('[Store3D] GLB load failed', loadError)
      error.value = '模型未能加载，请确认文件路径和 GLB 文件完整性。'
      loading.value = false
    })
  }

  function init(element, modelUrl) {
    host = element
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf4f7fb)
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000)
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.16
    renderer.shadowMap.enabled = true
    // PCFSoftShadowMap 已弃用（three 会回退到 PCF 并打警告），直接用 PCFShadowMap
    renderer.shadowMap.type = THREE.PCFShadowMap
    host.appendChild(renderer.domElement)

    /**
     * 环境贴图。这一步是"模型发灰发暗"的关键修复：
     * 模型 130 个材质全是 SimLab 给的 metallicFactor=0.5，而 PBR 里金属度高的表面
     * 靠环境反射成像 —— 原来场景只有半球光+两盏平行光、没有 scene.environment，
     * 于是所有半金属表面都渲染成死灰。RoomEnvironment 是 three 自带的程序化室内环境，
     * 零新增依赖、无需外部 HDR 文件。
     */
    pmrem = new THREE.PMREMGenerator(renderer)
    const roomEnvironment = new RoomEnvironment()
    envTexture = pmrem.fromScene(roomEnvironment, 0.04).texture
    roomEnvironment.dispose?.()
    scene.environment = envTexture
    scene.environmentIntensity = 0.85

    ambientLight = new THREE.HemisphereLight(0xffffff, 0x8ba2c0, 3.35)
    scene.add(ambientLight)
    keyLight = new THREE.DirectionalLight(0xffffff, 3.8)
    keyLight.position.copy(KEY_LIGHT_DIRECTION).multiplyScalar(38)
    keyLight.castShadow = true
    scene.add(keyLight)
    scene.add(keyLight.target)
    fillLight = new THREE.DirectionalLight(0xddeaff, 1.6)
    fillLight.position.copy(FILL_LIGHT_DIRECTION).multiplyScalar(25)
    scene.add(fillLight)
    setRenderProfile(renderProfile.value)

    orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.08
    orbit.screenSpacePanning = true
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    orbit.addEventListener('change', requestRender)

    pointer = new PointerLockControls(camera, renderer.domElement)
    // 漫游时纯鼠标转头也要重绘（否则画面会停在上一帧）
    pointer.addEventListener('change', requestRender)

    timer = new Timer()
    timer.connect(document)

    resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(host)
    // 滚出视口时停掉渲染循环：多标签、长页面、切到别的面板都不再空烧 GPU
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(entries => {
        onScreen = entries.some(entry => entry.isIntersecting)
        if (onScreen) requestRender()
        else stopLoop()
      }, { threshold: 0 })
      intersectionObserver.observe(host)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    updateSize()
    loadModel(modelUrl)
    requestRender()
  }

  function dispose() {
    stopLoop()
    exitRoam()
    resizeObserver?.disconnect()
    intersectionObserver?.disconnect()
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('pointerlockchange', onPointerLockChange)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (scene && modelRoot) { scene.remove(modelRoot); disposeObject(modelRoot) }
    if (grid) { scene?.remove(grid); grid.geometry?.dispose?.(); grid.material?.dispose?.() }
    disposeAnnotationGroup()
    if (keyLight) scene?.remove(keyLight.target)
    timer?.disconnect()
    envTexture?.dispose()
    pmrem?.dispose()
    scene && (scene.environment = null)
    orbit?.dispose()
    renderer?.dispose()
    renderer?.forceContextLoss?.()
    renderer?.domElement?.remove()
    host = scene = camera = renderer = orbit = pointer = grid = modelRoot = boundingBox = timer = keyLight = fillLight = ambientLight = pmrem = envTexture = null
  }

  onBeforeUnmount(dispose)
  return { loading, progress, error, statusText, modelInfo, isGridVisible, isAutoRotate, isRoaming, isFullscreen, renderProfile, init, dispose, resetView, setView, setGridVisible, setAutoRotate, setRenderProfile, setAnnotations, pickAt, pickAnnotationAt, focusPoint, enterRoam, exitRoam, toggleFullscreen }
}
