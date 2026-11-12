/**
 * scene.js —— three.js 视口封装：相机、光照、取景、拾取、FPS
 *
 * 只为 BIM 场景做取舍：
 *   - 不开阴影（12k 构件开阴影是灾难），改用半球光 + 双方向光把体积感做出来
 *   - 拾取区分「点击」和「拖拽旋转」，否则转完视角就误选中构件
 *   - 自动取景按「包围球 + 竖/横视场角较小者」算，不写死相机位置
 *
 * 取景必须同时算横竖两个视场角：面板一开一关，视口宽高比会从 2.4 掉到 1.0，
 * 只按竖直 FOV 算就会在窄视口里横向裁掉模型。
 * 另外 OrbitControls 的 maxDistance 必须按实际距离动态放开 —— 写死 50000 时
 * 相机被推到 99172 会被 update() 拽回 50000，表现就是"模型装不下"。
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

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1_000_000);
  camera.position.set(60, 40, 60);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.maxDistance = 5_000_000;   // 真实上限在 fit() 里按模型尺度重设
  controls.minDistance = 0.01;

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
  /** 用户动过相机之后就不再自动重新取景（否则一转视角就被拉回去） */
  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });

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
    // 面板收起/展开会改变宽高比，没被用户动过就重新取景，保证一直"装得下"
    if (!userMoved && modelRoot && !modelBox.isEmpty()) fit();
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

  /**
   * 包围球放到画面里需要的距离：取横竖两个视场角里较小的那个来算，
   * 这样窄视口（两侧面板都开着）也不会横向裁切。
   */
  function distanceFor(radius, margin) {
    const vFov = (camera.fov * Math.PI) / 180;
    const aspect = Math.max(camera.aspect || 1, 0.15);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fov = Math.min(vFov, hFov);
    return (radius / Math.sin(fov / 2)) * margin;
  }

  function applyClip(radius, dist) {
    camera.near = Math.max(0.01, Math.min(radius / 2000, dist / 5000));
    camera.far = dist + radius * 200;
    camera.updateProjectionMatrix();
  }

  const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

  function cornersOf(box) {
    const { min, max } = box;
    for (let i = 0; i < 8; i++) {
      _corners[i].set(
        i & 1 ? max.x : min.x,
        i & 2 ? max.y : min.y,
        i & 4 ? max.z : min.z
      );
    }
    return _corners;
  }

  /**
   * 按包围球算出来的距离对「扁平」模型太保守（半径取的是对角线一半，
   * 而楼层真正占的是长宽），画面里模型会缩成一小块。
   * 这里按 8 个角点的实际投影反复收紧：投影最大 |NDC| 就是「占了多少画面」，
   * 迭代 3 次即可收敛（透视投影对距离近似线性）。
   */
  function tightenDistance(box, center, dir, startDist, fill = 0.86) {
    const measure = (d) => {
      camera.position.copy(center).addScaledVector(dir, d);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      let maxAbs = 0;
      for (const c of cornersOf(box)) {
        const q = c.clone().project(camera);
        maxAbs = Math.max(maxAbs, Math.abs(q.x), Math.abs(q.y));
      }
      return maxAbs;
    };

    let dist = startDist;
    for (let i = 0; i < 6; i++) {
      const m = measure(dist);
      if (!Number.isFinite(m) || m <= 1e-6) return startDist;
      if (Math.abs(m - fill) / fill < 0.004) break;
      dist *= m / fill;
    }
    // 收尾兜底：宁可略远一点，也不让构件贴到画面边缘（0.98 就已经很难看了）
    const m = measure(dist);
    if (m > 0.94) dist *= m / 0.9;
    return dist;
  }

  /** 按包围盒把相机摆到能看全的位置 */
  function fit(box = modelBox, dir = new THREE.Vector3(1, 0.72, 1)) {
    if (!box || box.isEmpty()) return false;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1e-3);
    const d = dir.clone().normalize();

    // 先按包围球给个上界，再用角点投影收紧到刚好铺满（留 10% 余量）
    const dist = tightenDistance(box, center, d, distanceFor(radius, 1.18), 0.9);
    applyClip(radius, dist);

    camera.position.copy(center).addScaledVector(d, dist);
    camera.near = Math.max(0.01, Math.min(radius / 2000, dist / 5000));
    camera.far = dist + radius * 200;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = radius * 0.001;
    // 必须放开到比 dist 大，否则 update() 会把相机拽回来，模型永远装不满
    controls.maxDistance = Math.max(dist * 6, radius * 12);
    controls.update();

    grid.position.set(center.x, box.min.y, center.z);
    grid.scale.setScalar(Math.max(1, radius / 25));

    userMoved = false;
    return true;
  }

  /** 聚焦到某个构件/分组的包围盒（树上双击、3D 里定位时用） */
  function focusOn(box, margin = 1.35) {
    if (!box || box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1e-3);

    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.72, 1);
    dir.normalize();

    // 构件本身也可能很扁（一块楼板），同样用角点收紧；margin 比整体取景松一点
    const dist = tightenDistance(box, center, dir, distanceFor(radius, margin + 0.6), 0.82);
    applyClip(radius, dist);

    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.minDistance = radius * 0.001;
    controls.maxDistance = Math.max(dist * 8, radius * 20);
    controls.update();

    userMoved = true; // 已经对准某个构件，别让 resize 把它拉回全景
    return true;
  }

  /** 俯视（正上方看平面） */
  function topView() {
    if (modelBox.isEmpty()) return;
    fit(modelBox, new THREE.Vector3(0, 1, 0.0001));
  }

  function setModel(root, box = null) {
    if (modelRoot) scene.remove(modelRoot);
    modelRoot = root;
    if (!root) {
      modelBox.makeEmpty();
      return;
    }
    scene.add(root);
    // 优先用调用方给的世界包围盒（批处理时顺手累出来的，比 setFromObject 可靠）
    modelBox = (box && !box.isEmpty()) ? box.clone() : new THREE.Box3().setFromObject(root);
    fit();
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
    get userMoved() { return userMoved; },
    setModel,
    fit,
    topView,
    focusOn,
    pick,
    resize,
    setGrid(v) { grid.visible = v; return v; },
    get gridVisible() { return grid.visible; },
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
