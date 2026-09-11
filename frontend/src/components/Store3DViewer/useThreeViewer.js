import { computed, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'

const VIEW_DIRECTIONS = {
  top: new THREE.Vector3(0, 1, 0),
  front: new THREE.Vector3(0, 0.16, 1),
  left: new THREE.Vector3(-1, 0.16, 0),
  right: new THREE.Vector3(1, 0.16, 0),
}

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
  let rafId = 0
  let resizeObserver = null
  let boundingBox = null
  let clock = null
  const keys = new Set()

  function updateSize() {
    if (!host || !renderer || !camera) return
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    camera.aspect = width / height
    camera.updateProjectionMatrix()
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
  }

  function setAutoRotate(value = !isAutoRotate.value) {
    isAutoRotate.value = Boolean(value)
    if (orbit) orbit.autoRotate = isAutoRotate.value
  }

  function onKeyDown(event) {
    if (!isRoaming.value) return
    const key = event.key.toLowerCase()
    if (['w', 'a', 's', 'd'].includes(key)) {
      keys.add(key)
      event.preventDefault()
    }
  }

  function onKeyUp(event) { keys.delete(event.key.toLowerCase()) }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === renderer?.domElement
    isRoaming.value = locked
    if (orbit) orbit.enabled = !locked
    if (!locked) keys.clear()
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

  function animate() {
    rafId = requestAnimationFrame(animate)
    const delta = clock?.getDelta?.() || 0
    updateRoam(delta)
    if (!isRoaming.value) orbit?.update()
    renderer?.render(scene, camera)
  }

  function loadModel(url) {
    loading.value = true
    error.value = ''
    progress.value = 0
    const loader = new GLTFLoader()
    loader.load(url, gltf => {
      if (modelRoot) { scene.remove(modelRoot); disposeObject(modelRoot) }
      modelRoot = gltf.scene
      modelRoot.traverse(node => {
        if (!node.isMesh) return
        node.castShadow = true
        node.receiveShadow = true
      })
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
      const gridSize = Math.max(modelInfo.value.maxDimension * 2.2, 12)
      grid?.geometry?.dispose?.()
      grid?.material?.dispose?.()
      grid = new THREE.GridHelper(gridSize, 32, 0x8ca7c9, 0xdbe7f3)
      grid.position.y = boundingBox.min.y - Math.max(modelInfo.value.maxDimension * 0.001, 0.01)
      grid.visible = isGridVisible.value
      scene.add(grid)
      frameModel()
      progress.value = 100
      loading.value = false
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
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8ba2c0, 3.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.8)
    keyLight.position.set(18, 28, 20)
    keyLight.castShadow = true
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xddeaff, 1.6)
    fillLight.position.set(-15, 12, -16)
    scene.add(fillLight)
    orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.08
    orbit.screenSpacePanning = true
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    pointer = new PointerLockControls(camera, renderer.domElement)
    clock = new THREE.Clock()
    resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(host)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    updateSize()
    loadModel(modelUrl)
    animate()
  }

  function dispose() {
    cancelAnimationFrame(rafId)
    exitRoam()
    resizeObserver?.disconnect()
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('pointerlockchange', onPointerLockChange)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    if (scene && modelRoot) { scene.remove(modelRoot); disposeObject(modelRoot) }
    if (grid) { scene?.remove(grid); grid.geometry?.dispose?.(); grid.material?.dispose?.() }
    orbit?.dispose()
    renderer?.dispose()
    renderer?.forceContextLoss?.()
    renderer?.domElement?.remove()
    host = scene = camera = renderer = orbit = pointer = grid = modelRoot = boundingBox = clock = null
  }

  onBeforeUnmount(dispose)
  return { loading, progress, error, statusText, modelInfo, isGridVisible, isAutoRotate, isRoaming, isFullscreen, init, dispose, resetView, setView, setGridVisible, setAutoRotate, enterRoam, exitRoam, toggleFullscreen }
}
