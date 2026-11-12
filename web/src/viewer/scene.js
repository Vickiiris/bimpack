/**
 * scene.js —— three.js 视口封装：相机、光照、取景、拾取、FPS
 *
 * 只为 BIM 场景做取舍：
 *   - 不开阴影（12k 构件开阴影是灾难），改用半球光 + 双方向光把体积感做出来
 *   - 拾取区分「点击」和「拖拽旋转」，否则转完视角就误选中构件
 *   - 自动取景按包围盒 + 视角留白算，不写死相机位置
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BG = 0xeef0f4;

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100_000);
  camera.position.set(60, 40, 60);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.maxDistance = 50_000;

  // 光照：半球光给基础亮度，主方向光给明暗关系，补光压死黑
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd6dbe3, 1.35);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 2.2, 1.4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-1.4, 0.8, -1);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.4);
  rim.position.set(0, -1, 0.6);
  scene.add(rim);

  // 地面网格：给尺度感知，可随时关
  const grid = new THREE.GridHelper(400, 40, 0xc9cfd8, 0xdde2e8);
  grid.material.transparent = true;
  grid.material.opacity = 0.75;
  grid.visible = false;
  scene.add(grid);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let modelRoot = null;
  let modelBox = new THREE.Box3();
  let frameCb = null;
  let rafId = 0;

  // ---- FPS ----
  const clock = new THREE.Clock();
  let frames = 0;
  let acc = 0;
  let fps = 0;

  function resize() {
    const parent = canvas.parentElement;
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);
  resize();

  function tick() {
    rafId = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    acc += dt;
    frames++;
    if (acc >= 0.5) {
      fps = Math.round(frames / acc);
      frames = 0;
      acc = 0;
      frameCb?.(fps);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  /** 按包围盒把相机摆到能看全的位置 */
  function fit(box = modelBox, dir = new THREE.Vector3(1, 0.72, 1)) {
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const fov = (camera.fov * Math.PI) / 180;
    // 留 1.25 倍余量，避免构件顶到画面边缘
    const dist = (radius / Math.sin(fov / 2)) * 1.25;

    camera.near = Math.max(0.01, dist / 5000);
    camera.far = dist * 200;
    camera.updateProjectionMatrix();

    camera.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
    controls.target.copy(center);
    controls.update();

    // 网格贴到模型底部
    grid.position.set(center.x, box.min.y, center.z);
    grid.scale.setScalar(Math.max(1, radius / 50));
  }

  /** 聚焦到某个构件的包围盒（树上点选时用） */
  function focusOn(box) {
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 2.2; // 比整体取景近一点，看得清
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.update();
  }

  function setModel(root) {
    if (modelRoot) scene.remove(modelRoot);
    modelRoot = root;
    if (root) {
      scene.add(root);
      modelBox = new THREE.Box3().setFromObject(root);
      fit();
    }
  }

  /**
   * 屏幕坐标拾取
   * @returns {{hit:object, rec:object}|null}
   */
  function pick(clientX, clientY, pickFn) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return pickFn ? pickFn(raycaster) : null;
  }

  // 点击 vs 拖拽：位移超过 5px 或按住超过 500ms 都不算点击
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let clickHandler = null;

  canvas.addEventListener('pointerdown', (e) => {
    downAt = performance.now();
    downX = e.clientX;
    downY = e.clientY;
  });

  canvas.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    const held = performance.now() - downAt;
    if (moved > 5 || held > 500) return; // 是在转视角，不是在点选
    clickHandler?.(e.clientX, e.clientY);
  });

  return {
    renderer,
    scene,
    camera,
    controls,
    raycaster,
    get modelBox() { return modelBox; },
    get fps() { return fps; },
    setModel,
    fit,
    focusOn,
    pick,
    resize,
    setGrid(v) { grid.visible = v; },
    onClick(fn) { clickHandler = fn; },
    onFrame(fn) { frameCb = fn; },
    dispose() {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
