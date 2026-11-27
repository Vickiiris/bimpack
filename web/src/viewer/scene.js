/**
 * scene.js —— three.js 视口封装：相机、光照、取景、拾取、FPS
 *
 * 只为 BIM 场景做取舍：
 *   - 不开阴影（12k 构件开阴影是灾难），改用半球光 + 双方向光把体积感做出来
 *   - **必须给一张环境贴图（IBL）**：PBR 的金属材质（metalness=1）几乎没有漫反射，
 *     颜色全部来自环境反射；只有平行光时它在屏幕上就是纯黑。用户上传 PBR 模型
 *     「全黑」基本都是这一条，不是材质没读到。
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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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

  // 环境贴图（IBL）：金属 / 光滑材质的颜色与反射都来自它。
  // RoomEnvironment 是 three 自带的中性室内环境，离线生成、不依赖外部 HDRI 文件。
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  // 注意 three r170 的一个坑：只要场景里有 environment，**逐材质的 envMapIntensity
  // 就会被忽略**（WebGLRenderer 用 scene.environmentIntensity 覆盖它）。
  // 所以这里场景级强度给 0，改由 bim-batch 把这张贴图挂到真正需要它的材质上
  // （金属 / 透射玻璃），电介质完全不受影响 —— 灰墙不会被洗白。
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0;
  pmrem.dispose();

  // 光照：环境贴图给基础亮度与环境反射，方向光只负责明暗关系。
  // 加了 IBL 之后方向光相应减弱 —— 两者的总能量要和原来只靠灯时接近，
  // 否则模型会整体发白（这也是「加了环境贴图反而更难看」的常见原因）。
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
    // 面板收起/展开会改变宽高比，没被用户动过就重新取景，保证一直"装得下"。
    // 这里必须是瞬时摆位：拖窗口时 ResizeObserver 会连续触发，动画会互相打架
    if (!userMoved && modelRoot && !modelBox.isEmpty()) fit(modelBox, undefined, { animate: false });
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);
  resize();

  // ---- 相机过渡：动画期间自己插值，交还给 OrbitControls 时它能从 position/target 重算球坐标 ----
  /** 正在进行的相机动画（null = 无）。必须在 tick() 之前声明，首帧就会读它 */
  let anim = null;
  /**
   * 当前取景对象的参考半径（fit = 整模型，focus = 那个构件）。
   * 近/远裁面按「当前相机距离 + 这个半径」每帧自算，见 updateClip()。
   */
  let clipRadius = 1;
  /**
   * 「返回点」：双击聚焦之前的相机状态。
   * 每轮聚焦只在**第一次**记录（A → B 连跳时返回点仍是 A 之前的全景），
   * 还原后清空；点「适应视图」也会清空。
   */
  let savedView = null;

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
    if (anim) stepAnim(performance.now());
    else controls.update();
    updateClip();
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

  const HOME_DIR = new THREE.Vector3(1, 0.72, 1);
  /** 过渡时长（毫秒）：聚焦略长一点，返回 / 适应视图短一点，避免拖沓 */
  const DUR_FOCUS = 620;
  const DUR_RETURN = 520;
  const DUR_FIT = 460;

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /**
   * 相机状态快照：position + target + near/far + 距离上下限。
   * OrbitControls 每次 update 都从「position − target」重算球坐标，所以这五个值足以还原一次取景。
   */
  function snapshot() {
    return {
      pos: camera.position.clone(),
      target: controls.target.clone(),
      near: camera.near,
      far: camera.far,
      minDistance: controls.minDistance,
      maxDistance: controls.maxDistance,
      radius: clipRadius,
      userMoved,
    };
  }

  /**
   * 近 / 远裁面跟着**当前观察距离**走，而不是钉死在某个视点算出来的值。
   *
   * 为什么必须这样：聚焦一个构件后相机距离很小，如果 far 还停在那里算出的值，
   * 用户一旦用滚轮往外拉，整栋楼就会被远裁面切掉 —— 表现正是「滚轮往下拉看不到东西、回不去」。
   * 反过来，如果为了让远处可见把 far 一次性放大，近距离又会 z-fighting。
   * 所以每帧按 d 重算：near 取 d/5000（不许小于 0.01），far 取 max(d×4, 取景半径×200)。
   */
  function updateClip() {
    const d = Math.max(camera.position.distanceTo(controls.target), 1e-6);
    // near 跟着 d 走（d/3000）：拉得越远，近裁面越大，深度精度才够；
    // 上限再压一个 clipRadius/50，贴着构件看时不会被裁掉。
    const near = Math.max(0.01, Math.min(d / 3000, clipRadius / 50));
    const far = Math.max(d * 4, clipRadius * 200);
    if (Math.abs(near - camera.near) > camera.near * 1e-3 || Math.abs(far - camera.far) > camera.far * 1e-3) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  function applyView(v) {
    camera.position.copy(v.pos);
    controls.target.copy(v.target);
    camera.near = v.near;
    camera.far = v.far;
    if (v.radius) clipRadius = v.radius;
    camera.updateProjectionMatrix();
    controls.minDistance = v.minDistance;
    controls.maxDistance = v.maxDistance;
    controls.update();
    updateClip();
    userMoved = v.userMoved;
  }

  /** 立即结束过渡（用户一动相机就交还控制权，停在中途，不硬拽到终点） */
  function stopAnim() {
    if (!anim) return false;
    anim = null;
    controls.update();
    return true;
  }

  function flyTo(to, duration) {
    if (!(duration > 0)) { applyView(to); return; }
    // 立刻把 userMoved 置成目标值：过渡途中若发生 resize（面板宽度变了），
    // 不能让 resize 里的自动取景把正在飞的相机拽回全景。
    userMoved = to.userMoved;
    anim = {
      from: snapshot(),
      to,
      t0: performance.now(),
      dur: duration,
    };
    // 过渡期间距离限制按终点放开，否则中途会被 maxDistance 拽一下
    controls.minDistance = Math.min(controls.minDistance, to.minDistance);
    controls.maxDistance = Math.max(controls.maxDistance, to.maxDistance);
  }

  function stepAnim(now) {
    const a = anim;
    if (!a) return;
    const t = Math.min(1, (now - a.t0) / a.dur);
    const k = easeInOut(t);
    camera.position.lerpVectors(a.from.pos, a.to.pos, k);
    controls.target.lerpVectors(a.from.target, a.to.target, k);
    camera.near = Math.max(1e-4, a.from.near + (a.to.near - a.from.near) * k);
    camera.far = Math.max(camera.near * 10, a.from.far + (a.to.far - a.from.far) * k);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
    if (t >= 1) {
      anim = null;
      applyView(a.to);
    }
  }

  /**
   * 解出「看向 box、方向 dir、按角点收紧到占画面 fill」的相机状态。
   *
   * tightenDistance 是「先把相机摆过去再量投影」，量完必须把相机还原 ——
   * 否则动画的起点就被弄脏了（会看到第一帧闪一下）。
   */
  function viewFor(box, dir, margin, fill, maxFactor) {
    const keep = snapshot();
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1e-3);
    const d = dir.clone().normalize();
    const dist = tightenDistance(box, center, d, distanceFor(radius, margin), fill);

    camera.position.copy(keep.pos);
    camera.near = keep.near;
    camera.far = keep.far;
    camera.updateProjectionMatrix();

    const near = Math.max(0.01, Math.min(radius / 2000, dist / 5000));
    const far = dist + radius * 200;

    /**
     * 拉远上限必须照顾到「整模型」：
     * 聚焦一个螺栓时 box 只有几厘米，dist×8 连一层楼都拉不到，
     * 滚轮往下就「顶住」了 —— 这正是「滚轮无法往下、回不到全景」的直接原因。
     * 所以取「当前取景距离的小倍数」与「整模型取景距离」的较大者。
     */
    const modelRadius = modelBox.isEmpty()
      ? radius
      : Math.max(modelBox.getBoundingSphere(new THREE.Sphere()).radius, radius);
    const modelDist = distanceFor(modelRadius, 1.18);

    return {
      pos: center.clone().addScaledVector(d, dist),
      target: center,
      near,
      far,
      radius,
      minDistance: Math.max(radius * 0.001, modelRadius * 1e-5),
      maxDistance: Math.max(dist * (maxFactor || 6), radius * 12, modelDist * 2),
      userMoved: false,
    };
  }

  /**
   * 按包围盒把相机摆到能看全的位置（=「适应视图」/ 初始视角）。
   * @param {{animate?: boolean}} [opts] animate=false 用于加载新模型：直接摆好，不从旧模型的视角飞过来
   */
  function fit(box = modelBox, dir = HOME_DIR, opts = {}) {
    if (!box || box.isEmpty()) return false;
    const v = viewFor(box, dir, 1.18, 0.9, 6);
    v.userMoved = false;

    // 回到全景就等同于「初始状态」：旧的返回点作废，避免 Esc 又飞回复焦之前的视角
    savedView = null;
    flyTo(v, opts.animate === false ? 0 : DUR_FIT);

    const center = v.target;
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    grid.position.set(center.x, box.min.y, center.z);
    grid.scale.setScalar(Math.max(1, radius / 25));
    return true;
  }

  /**
   * 聚焦到某个构件/分组的包围盒（树上双击、3D 里双击时用）。
   *
   * 第一轮聚焦前把当前视角记成「返回点」，`restoreView()` 原路飞回；
   * 连续双击不同目标时不覆盖返回点，所以最终总能回到最初的全景。
   */
  function focusOn(box, opts = {}) {
    if (!box || box.isEmpty()) return false;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.72, 1);
    dir.normalize();

    // 构件本身也可能很扁（一块楼板），同样用角点收紧；margin 比整体取景松一点
    const v = viewFor(box, dir, 1.95, 0.82, 8);
    v.userMoved = true; // 已经对准某个构件，别让 resize 把它拉回全景

    if (opts.remember !== false && !savedView) savedView = snapshot();
    flyTo(v, opts.duration ?? DUR_FOCUS);
    return true;
  }

  /**
   * 回到初始状态：有返回点就飞回返回点，没有就重新整体取景（适应视图）。
   * @returns {boolean} 是否有可复原的视角
   */
  function restoreView(opts = {}) {
    const v = savedView;
    savedView = null;
    if (v) {
      flyTo({ ...v, userMoved: v.userMoved }, opts.duration ?? DUR_RETURN);
      return true;
    }
    return fit(modelBox, HOME_DIR, { ...opts, duration: opts.duration ?? DUR_FIT });
  }

  /** 俯视（正上方看平面） */
  function topView() {
    if (modelBox.isEmpty()) return;
    fit(modelBox, new THREE.Vector3(0, 1, 0.0001));
  }

  function setModel(root, box = null) {
    if (modelRoot) scene.remove(modelRoot);
    modelRoot = root;
    savedView = null;
    stopAnim();
    if (!root) {
      modelBox.makeEmpty();
      return;
    }
    scene.add(root);
    // 优先用调用方给的世界包围盒（批处理时顺手累出来的，比 setFromObject 可靠）
    modelBox = (box && !box.isEmpty()) ? box.clone() : new THREE.Box3().setFromObject(root);
    // 换模型直接摆到初始视角，别从上一个模型的视角飞过来
    fit(modelBox, HOME_DIR, { animate: false });
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
  let dblclickHandler = null;

  canvas.addEventListener('pointerdown', (e) => {
    stopAnim(); // 用户接手：停在中途，别和动画抢相机
    downAt = performance.now();
    downX = e.clientX;
    downY = e.clientY;
  });
  canvas.addEventListener('wheel', stopAnim, { passive: true });

  canvas.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    const held = performance.now() - downAt;
    if (moved > 5 || held > 500) return; // 是在转视角，不是在点选
    clickHandler?.(e.clientX, e.clientY);
  });

  /**
   * 双击：3D 里双击构件的入口（触发的是「单击选中 + 相机聚焦」）。
   * 同样排掉拖拽 —— 转完视角松手时浏览器也可能补一个 dblclick，不能当双击用。
   */
  canvas.addEventListener('dblclick', (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > 5) return;
    dblclickHandler?.(e.clientX, e.clientY);
  });

  return {
    renderer,
    scene,
    /** PMREM 环境贴图：Batch 侧按金属度挂到材质上，见 bim-batch 的 tuneEnvMap */
    envMap: envRT.texture,
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
    /** 回到聚焦前的视角；没有返回点时退回「适应视图」 */
    restoreView,
    /** 是否有可复原的返回点（Esc / 再次双击时用） */
    get canRestore() { return !!savedView; },
    /** 相机是否正在过渡（动画期间不要再叠一次跳转） */
    get animating() { return !!anim; },
    pick,
    resize,
    setGrid(v) { grid.visible = v; return v; },
    get gridVisible() { return grid.visible; },
    onClick(fn) { clickHandler = fn; },
    onDblClick(fn) { dblclickHandler = fn; },
    onFrame(fn) { frameCb = fn; },
    dispose() {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
