import * as THREE from 'three';
import * as GaussianSplats3D from './node_modules/@mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js';

window.__three = THREE;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const fileInput = document.getElementById('file');
const worldPinsEl = document.getElementById('worldPins');
const pkList = document.getElementById('pkList');
const dropHint = document.getElementById('drop-hint');
const fpsEl = document.getElementById('fps');
const devicePanelsEl = document.getElementById('devicePanels');
const pickPanel = document.getElementById('pickPanel');

let viewer = null;
let currentSceneURL = null;
let pickMode = false;
let worldPins = [];
let picks = [];
let pinSeq = 1;
let lastCam = null;

const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _v = new THREE.Vector3();
const RENDER_DPR = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
const SPAWN = [1.826, 0.635, 0.135]; // 用户标记点(0.297,0.635,-1.156)沿水平视线后退 2m，避免相机嵌进 137万点云近场
const SPAWN_LOOK = [-9, 5, -9];

function setStatus(t) { statusEl.textContent = t; }

// ---------- 加载模型（保留，不影响模型） ----------
async function loadSplat(url, label, cam, xf) {
  setStatus('加载中：' + (label || url));
  if (viewer) { try { viewer.dispose(); } catch (e) {} viewer = null; }
  worldPins.forEach(p => p.el.remove()); worldPins = [];
  const camPos = (cam && cam.pos) ? cam.pos : [0, 2.2, 6];
  const camLook = (cam && cam.look) ? cam.look : [0, 0.6, 0];
  const camUp = (cam && cam.up) ? cam.up : [0, 1, 0];
  lastCam = { pos: camPos, look: camLook, up: camUp };
  const transform = xf || { rotation: [0, 0, 0, 1], position: [0, 0, 0] };
  try {
    viewer = new GaussianSplats3D.Viewer({ rootElement: viewerEl, cameraUp: camUp, initialCameraPosition: camPos, initialCameraLookAt: camLook, selfDrivenMode: true, gpuAcceleratedSort: false, sharedMemoryForWorkers: false, devicePixelRatio: RENDER_DPR, antialiased: true });
    window.__viewer = viewer; // 调试/自动验证用：暴露 viewer 实例
    await viewer.addSplatScene(url, { splatAlphaRemovalThreshold: 1, showLoadingUI: true, position: transform.position, rotation: transform.rotation, scale: [1, 1, 1], progressiveLoad: false });
    viewer.start(); currentSceneURL = url;
    try { if (viewer.renderer) viewer.renderer.setClearColor(0xeceff3, 1); if (viewer.scene) viewer.scene.background = new THREE.Color(0xeceff3); } catch (e) {}
    enterRoam();   // 加载完成即进入第一人称模式（唯一交互模式）
    setStatus('已加载' + (label ? '：' + label : ''));
  } catch (e) { console.error(e); setStatus('加载失败：' + (e && e.message ? e.message : e)); }
}

// ---------- 拾取模型表面坐标（gsplat splat 树射线精确命中） ----------
function pickSurface(clientX, clientY) {
  if (!viewer || !viewer.camera || !viewer.raycaster || !viewer.splatMesh) return null;
  const rect = viewerEl.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  // 用 CSS 像素尺寸计算 NDC，和鼠标点击坐标同单位
  _ndc.set(px, py);
  const rd = new THREE.Vector2(rect.width, rect.height);
  viewer.raycaster.setFromCameraAndScreenPosition(viewer.camera, _ndc, rd);
  _pickHits.length = 0;
  viewer.raycaster.intersectSplatMesh(viewer.splatMesh, _pickHits);
  if (_pickHits.length === 0) return null;
  const h = _pickHits[0];
  return [h.origin.x, h.origin.y, h.origin.z];
}

// ---------- 每帧投影拾取点 ----------
function updateWorldPins() {
  if (!viewer || !viewer.camera) return;
  const cam = viewer.camera; const w = viewerEl.clientWidth; const h = viewerEl.clientHeight;
  worldPins.forEach(wp => {
    _v.copy(wp.point).project(cam);
    if (_v.z > 1) { wp.el.style.display = 'none'; return; }
    wp.el.style.display = ''; wp.el.style.left = ((_v.x * 0.5 + 0.5) * w) + 'px'; wp.el.style.top = ((-_v.y * 0.5 + 0.5) * h) + 'px';
  });
}
let _frames = 0, _fpsT = performance.now();
function tick() {
  updateWorldPins();
  if (tour) tourUpdate();
  else if (roam && viewer && viewer.camera) roamMove();
  updateDevicePanels();
  _frames++;
  const _now = performance.now();
  if (_now - _fpsT >= 500) {
    if (fpsEl) fpsEl.textContent = Math.round(_frames * 1000 / (_now - _fpsT)) + ' FPS';
    _frames = 0; _fpsT = _now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 点击拾取（区分拖拽与点击） ----------
let downX = 0, downY = 0, downT = 0;
viewerEl.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; downT = Date.now(); });
viewerEl.addEventListener('pointerup', e => {
  if (!pickMode || !viewer) return;
  if (e.target.closest('#pickPanel')) return;            // 面板内操作不触发拾取
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved > 6 || Date.now() - downT > 600) return;     // 拖拽/长按 → 不拾取
  const hit = pickSurface(e.clientX, e.clientY);
  if (!hit) { setStatus('未命中模型表面，请点击模型上'); return; }
  addPick(hit);
});

function addPick(p) {
  const x = +p[0].toFixed(3), y = +p[1].toFixed(3), z = +p[2].toFixed(3);
  const id = pinSeq++;
  const el = document.createElement('div'); el.className = 'wpin'; el.dataset.pid = id; el.style.setProperty('--c', '#2b7cd3');
  el.innerHTML = `<div class="wdot"></div><div class="wlbl">#${id} (${x}, ${y}, ${z})</div>`;
  worldPinsEl.appendChild(el);
  worldPins.push({ el, point: new THREE.Vector3(x, y, z) });
  picks.push({ id, x, y, z });
  renderPicks();
  setStatus('已拾取 #' + id + '：(' + x + ', ' + y + ', ' + z + ')');
}

function renderPicks() {
  if (!picks.length) { pkList.innerHTML = '<div class="pk-empty">尚未拾取任何坐标</div>'; return; }
  pkList.innerHTML = picks.map(p => `<div class="pk-item" data-id="${p.id}"><span class="seq">#${p.id}</span><span class="xyz">X ${p.x} · Y ${p.y} · Z ${p.z}</span><span class="del" data-del="${p.id}">✕</span></div>`).join('');
  pkList.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => {
    const id = +b.dataset.del;
    picks = picks.filter(x => x.id !== id);
    const wp = worldPins.find(w => +w.el.dataset.pid === id);
    if (wp) { wp.el.remove(); worldPins = worldPins.filter(w => w !== wp); }
    renderPicks();
  }; });
}

// ---------- 设备数据面板（按泵种类换色） ----------
const devicePanels = [];
const SHOW_DIST = 25;     // 超过此距离完全不显示
const CLOSE_DIST = 8;     // 此距离以内达到最大缩放
const FOCUS = 0.7;        // 焦点区 NDC 半宽；锚点超出此范围即视为屏幕边缘，不显示面板
const MIN_SCALE = 0.7;    // 焦点区内最远可见时的缩放（整体调大）
const MAX_SCALE = 1.1;    // 焦点区中心+最近时的缩放上限（局部区域更大）
const LEADER_H = 26;      // 牵引线长度（px）
const GAP = 110;          // 同屏可见面板的最小水平间距（防重叠，随面板变大而加大）
const TOP_M = 12, BOT_M = 12; // 面板与视口上下边的最小留白（防裁切）
const PANEL_TYPES = {
  sec:   { color: '#2b7cd3', label: '二级泵' },
  circ:  { color: '#13a085', label: '循环泵' },
  supp:  { color: '#e0821e', label: '补水泵' },
  level: { color: '#9b59b6', label: '液位传感器' },
  heat:  { color: '#e74c3c', label: '换热器' },
  meter: { color: '#00bcd4', label: '热表' },
};
let deviceFrame = 0;
const _ocHits = [];
const _pickHits = [];
function addDevicePanel(d) {
  const ty = PANEL_TYPES[d.type] || PANEL_TYPES.sec;
  const el = document.createElement('div'); el.className = 'devpanel';
  el.style.setProperty('--accent', ty.color);
  // 自定义字段行：液位传感器等只显示部分数据；未指定则默认功率/扬程/流量
  const rows = (d.rows && d.rows.length)
    ? d.rows
    : [
        { k: '功率', v: d.power },
        { k: '扬程', v: d.head },
        { k: '流量', v: d.flow },
      ];
  el.innerHTML =
    `<div class="dp-head"><span class="dp-dot"></span><span class="dp-name">${d.name}</span></div>` +
    `<div class="dp-rows">` +
    rows.map(r => `<div class="dp-row"><span>${r.k}</span><b>${r.v}</b></div>`).join('') +
    `</div>`;
  const markerEl = document.createElement('div'); markerEl.className = 'devmarker';
  markerEl.style.background = ty.color;
  markerEl.style.boxShadow = `0 0 6px ${ty.color}`;
  markerEl.innerHTML = `<b>${d.tag || ''}</b>`;
  const leaderEl = document.createElement('div'); leaderEl.className = 'devleader';
  leaderEl.style.setProperty('--accent', ty.color);
  leaderEl.style.background = ty.color;
  devicePanelsEl.appendChild(el);
  devicePanelsEl.appendChild(markerEl);
  devicePanelsEl.appendChild(leaderEl);
  devicePanels.push({ el, markerEl, leaderEl, tag: d.tag || '',
    nudgeX: (d.tag === '#1' ? -52 : (d.tag === '#2' ? 52 : 0)),
    color: ty.color,
    point: new THREE.Vector3(d.point[0], d.point[1], d.point[2]), occluded: false });
}
// 通过 gsplat 射线拾取（splat 树遍历）判断是否被模型遮挡：最近命中比面板点更近即遮挡
function isOccluded(point, px, py) {
  if (!viewer || !viewer.raycaster || !viewer.splatMesh) return false;
  try {
    const rd = new THREE.Vector2(); viewer.getRenderDimensions(rd);
    viewer.raycaster.setFromCameraAndScreenPosition(viewer.camera, new THREE.Vector2(px, py), rd);
    _ocHits.length = 0;
    viewer.raycaster.intersectSplatMesh(viewer.splatMesh, _ocHits);
    if (_ocHits.length === 0) return false;
    const dPoint = viewer.camera.position.distanceTo(point);
    return _ocHits[0].distance < dPoint - 0.3;
  } catch (e) { return false; }
}
function updateDevicePanels() {
  if (!viewer || !viewer.camera) return;
  const cam = viewer.camera; const w = viewerEl.clientWidth; const h = viewerEl.clientHeight;
  deviceFrame++;
  const vis = [];
  devicePanels.forEach(p => {
    const dist = cam.position.distanceTo(p.point);
    if (dist > SHOW_DIST) { p.el.style.display = 'none'; p.markerEl.style.display = 'none'; p.leaderEl.style.display = 'none'; return; }
    _v.copy(p.point).project(cam);
    // 仅在「焦点区」内显示：锚点跑到相机后方、或超出焦点半宽 FOCUS（屏幕边缘）时，整体隐藏，不显示面板
    const edge = _v.z > 1 || _v.x < -FOCUS || _v.x > FOCUS || _v.y < -FOCUS || _v.y > FOCUS;
    if (edge) { p.el.style.display = 'none'; p.markerEl.style.display = 'none'; p.leaderEl.style.display = 'none'; return; }
    const px = (_v.x * 0.5 + 0.5) * w, py = (-_v.y * 0.5 + 0.5) * h;
    if (deviceFrame % 8 === 0) p.occluded = isOccluded(p.point, px, py); // 节流，避免每帧射线开销
    if (p.occluded) {                                  // 被遮挡：只留印记，不展示面板/牵引线
      p.el.style.display = 'none'; p.leaderEl.style.display = 'none';
      p.markerEl.style.display = '';
      p.markerEl.style.left = px + 'px';
      p.markerEl.style.top = py + 'px';
      return;
    }
    p.px = px; p.py = py;
    p.tx = px + p.nudgeX; p.ty = py - LEADER_H;
    // 缩放：近大远小（距离 t）+ 越靠视野中心越大（中心度 c）；焦点区外已在上面隐藏
    const t = Math.min(1, Math.max(0, (SHOW_DIST - dist) / (SHOW_DIST - CLOSE_DIST)));
    const c = 1 - Math.max(Math.abs(_v.x), Math.abs(_v.y)) / FOCUS; // 0~1，越靠中心越大
    p.scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * (0.55 * t + 0.45 * c);
    vis.push(p);
  });
  // 自动防重叠：按锚点屏幕 X 排序，保证左锚点对应左面板、右锚点对应右面板，避免引线交叉
  vis.sort((a, b) => a.px - b.px);
  for (let i = 1; i < vis.length; i++) {
    if (vis[i].tx - vis[i - 1].tx < GAP) vis[i].tx = vis[i - 1].tx + GAP;
  }
  // 限制牵引线水平跨度，避免面板被推得离锚点过远、留下跨屏长斜线
  const MAX_LEADER_W = 150;
  vis.forEach(p => { p.tx = Math.max(p.px - MAX_LEADER_W, Math.min(p.px + MAX_LEADER_W, p.tx)); });
  // 渲染（牵引线连回真实锚点；不再把面板夹回屏幕内，避免粘黏在边缘）
  vis.forEach(p => {
    if (!p.h) p.h = p.el.offsetHeight || 44;             // 缓存未缩放布局高度
    const ph = p.h * p.scale;
    p.markerEl.style.display = 'none';
    p.el.style.display = '';
    p.el.classList.remove('below');
    // 默认放在锚点上方；若顶部空间不足（靠近/仰视时），自动翻转到下方，避免被屏幕裁切而看不清
    const roomAbove = (p.py - LEADER_H) - ph >= TOP_M;
    let ty, originY, nySign;
    if (roomAbove) { ty = p.py - LEADER_H; originY = -100; nySign = -1; }
    else { ty = p.py + LEADER_H; originY = 0; nySign = 1; p.el.classList.add('below'); }
    const nx = p.tx - p.px, ny = nySign * LEADER_H;
    const lineLen = Math.sqrt(nx * nx + ny * ny);
    const angle = Math.atan2(ny, nx) * 180 / Math.PI;
    p.el.style.left = p.tx + 'px';
    p.el.style.top = ty + 'px';
    p.el.style.transform = `translate(-50%, ${originY}%) scale(${p.scale})`;
    p.leaderEl.style.display = '';
    p.leaderEl.style.left = p.px + 'px';
    p.leaderEl.style.top = p.py + 'px';
    p.leaderEl.style.width = lineLen + 'px';
    p.leaderEl.style.transform = `rotate(${angle}deg)`;
  });
}
// 设备清单（坐标由用户提供；数值已回填）
// 二级泵
addDevicePanel({ type: 'sec',  name: '二级泵 #1', tag: '#1', point: [6.138, 1.289, 0.132], power: '45 kW', head: '36 m', flow: '80 m³/h' });
addDevicePanel({ type: 'sec',  name: '二级泵 #2', tag: '#2', point: [6.153, 1.33, 1.339], power: '45 kW', head: '36 m', flow: '80 m³/h' });
// 循环泵
addDevicePanel({ type: 'circ', name: '循环泵 #1', tag: '#1', point: [7.236, 1.755, -3.036], power: '45 kW', head: '32 m', flow: '160 m³/h' });
addDevicePanel({ type: 'circ', name: '循环泵 #2', tag: '#2', point: [8.282, 1.956, -2.901], power: '45 kW', head: '32 m', flow: '160 m³/h' });
// 补水泵
addDevicePanel({ type: 'supp', name: '补水泵 #1', tag: '#1', point: [7.88, 1.341, -4.914], power: '4 kW', head: '30 m', flow: '30 m³/h' });
addDevicePanel({ type: 'supp', name: '补水泵 #2', tag: '#2', point: [7.917, 1.353, -5.273], power: '4 kW', head: '30 m', flow: '30 m³/h' });
// 液位传感器
addDevicePanel({ type: 'level', name: '液位传感器', point: [3.828, 2.385, -7.533], rows: [{ k: '液位', v: '1.2 M' }] });
// 换热器
addDevicePanel({ type: 'heat', name: '换热器 #1', point: [6.299, 1.934, -4.098], rows: [{ k: '换热面积', v: '42.6 m²' }, { k: '换热量', v: '1600 kW' }] });
// 热表
addDevicePanel({ type: 'meter', name: '热表 #1', point: [4.555, 2.91, 2.616], rows: [{ k: '温度', v: '60 ℃' }] });

// ---------- 选取坐标开关 ----------
const pickChk = document.getElementById('pickChk');
pickChk.addEventListener('change', () => {
  pickMode = pickChk.checked;
  viewerEl.style.cursor = pickMode ? 'crosshair' : '';
  setStatus(pickMode ? '选取坐标模式：点击模型表面取点' : '已退出选取坐标');
});
document.getElementById('clearPickBtn').onclick = () => {
  worldPins.forEach(p => p.el.remove()); worldPins = []; picks = []; pinSeq = 1; renderPicks(); setStatus('已清空拾取点');
};
document.getElementById('copyPickBtn').onclick = () => {
  if (!picks.length) { setStatus('没有可复制的坐标'); return; }
  const text = picks.map(p => `#${p.id}\tX=${p.x}\tY=${p.y}\tZ=${p.z}`).join('\n');
  navigator.clipboard.writeText(text).then(() => setStatus('已复制 ' + picks.length + ' 个坐标'), () => setStatus('复制失败'));
};

// ---------- 第一人称模式（唯一交互模式） ----------
let roam = true, yaw = 0, pitch = 0, keys = {}, dragging = false, lastX = 0, lastY = 0;
const roamHelp = document.getElementById('roamHelp');
const COLLISION_RADIUS = 0.5;            // 与墙/设备保持的最小间距（米）；>0 即“碰撞开启”
const _UP = new THREE.Vector3(0, 1, 0);
const _collHits = [];
// 沿任意方向对 3DGS 表面做射线检测，返回最近命中距离（无命中返回 Infinity）
function castSplatDist(origin, dir) {
  if (!viewer || !viewer.raycaster || !viewer.splatMesh) return Infinity;
  try {
    _collHits.length = 0;
    viewer.raycaster.ray.origin.copy(origin);
    viewer.raycaster.ray.direction.copy(dir).normalize();
    viewer.raycaster.intersectSplatMesh(viewer.splatMesh, _collHits);
    return _collHits.length ? _collHits[0].distance : Infinity;
  } catch (e) { return Infinity; }
}
function enterRoam() {
  roam = true; const cam = viewer.camera;
  const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
  yaw = Math.atan2(dir.x, dir.z); pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  if (viewer.controls) {
    const c = viewer.controls;
    c.enabled = false;        // 关闭轨道输入，避免和第一人称抢相机
    c.enableDamping = false;  // 关阻尼，防止 update() 平滑把朝向拉回旧 target
    c.minPolarAngle = 0;     // 放开俯仰限制，配合我们自己的 pitch 钳制
    c.maxPolarAngle = Math.PI;
  }
  if ('transitioningCameraTarget' in viewer) viewer.transitioningCameraTarget = false; // 终止可能进行中的聚焦动画
  pickChk.checked = false; pickMode = false; viewerEl.style.cursor = '';
  roamHelp.classList.add('show'); setStatus('第一人称模式：WASD 移动 · Q/E 升降 · 拖拽鼠标转向（碰撞已开启）');
  applyLook();
}
function applyLook() {
  const cam = viewer.camera;
  const dir = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
  // 关键：把 OrbitControls 的 target 同步到相机正前方，否则 Viewer 内部每帧 controls.update() 的 camera.lookAt(target) 会覆盖我们的朝向
  if (viewer.controls) viewer.controls.target.copy(cam.position).add(dir);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  const m = new THREE.Matrix4().makeBasis(right, realUp, dir.clone().multiplyScalar(-1));
  cam.quaternion.setFromRotationMatrix(m);
}
// 带碰撞的移动：沿 moveVec 方向尝试移动，若前方 splat 表面在 (距离 - 半径) 内则夹紧步长（实现贴墙滑行 + 不穿墙）
function tryMove(moveVec) {
  const cam = viewer.camera;
  const dist = moveVec.length();
  if (dist < 1e-6) return;
  const dir = moveVec.clone().normalize();
  const d = castSplatDist(cam.position, dir);
  let step = dist;
  if (dist > d - COLLISION_RADIUS) {
    const allowed = d - COLLISION_RADIUS;
    if (allowed <= 0) return;            // 紧贴墙体，禁止该方向
    step = allowed;                      // 贴着墙停在过去半径处
  }
  cam.position.addScaledVector(dir, step);
}
function roamMove() {
  if (!viewer || !viewer.camera) return;
  const sp = 6 * 0.016; const cam = viewer.camera;
  const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
  const right = new THREE.Vector3().crossVectors(dir, _UP).normalize();
  if (keys['w']) tryMove(dir.clone().multiplyScalar(sp));
  if (keys['s']) tryMove(dir.clone().multiplyScalar(-sp));
  if (keys['a']) tryMove(right.clone().multiplyScalar(-sp));
  if (keys['d']) tryMove(right.clone().multiplyScalar(sp));
  if (keys['q']) tryMove(_UP.clone().multiplyScalar(-sp));
  if (keys['e']) tryMove(_UP.clone().multiplyScalar(sp));
  applyLook();
}
viewerEl.addEventListener('mousedown', e => { if (roam) { dragging = true; lastX = e.clientX; lastY = e.clientY; } });
window.addEventListener('mouseup', () => dragging = false);
window.addEventListener('mousemove', e => {
  if (roam && dragging) { const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; yaw -= dx * 0.005; pitch = THREE.MathUtils.clamp(pitch - dy * 0.005, -1.5, 1.5); applyLook(); }
});
window.addEventListener('keydown', e => { if (roam) keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { if (roam) keys[e.key.toLowerCase()] = false; });

// ---------- 自动导览（规定轨道巡游，按文案/旁白时间轴展示功能） ----------
// 时间轴对齐「换热站推销配音_泽言_1.0x」字幕（11 段，总时长 67.5s）；每段对应一个镜头机位。
const TOUR_SEGS = [
  { t0: 0.000,  t1: 6.109,  cap: '在工业数字化转型的今天，换热站还靠人工巡检、凭经验判断吗？' },
  { t0: 6.329,  t1: 13.069, cap: '我们基于三维高斯泼溅技术，将真实站房厘米级高保真还原于数字空间。' },
  { t0: 13.289, t1: 16.238, cap: '以电脑版为例，三大核心能力：' },
  { t0: 16.458, t1: 19.197, cap: '第一，沉浸式第一人称漫游。' },
  { t0: 19.417, t1: 29.317, cap: 'W A S D 行走、Q E 升降，内置碰撞约束，沿设备表面平稳行进、杜绝穿模，拖拽即可身临其境环视全场。' },
  { t0: 29.537, t1: 31.854, cap: '第二，实时数据可视化。' },
  { t0: 32.074, t1: 41.132, cap: '六类设备以悬浮看板呈现、按类型着色；越近越清晰，移出视野自动收起，被遮挡仅留定位标识。' },
  { t0: 41.352, t1: 43.458, cap: '第三，空间坐标拾取。' },
  { t0: 43.678, t1: 48.313, cap: '点击模型表面即可记录世界坐标，便于资产标注。' },
  { t0: 48.533, t1: 58.433, cap: '未来还将对接 S C A D A、P L C 实现实时告警，构建巡检工单一键派单，并支撑集团级多站点统一管控。' },
  { t0: 58.653, t1: 67.500, cap: '从“可视”走向“可管、可控”——换热站数字孪生，让每一份热能、每一笔成本，清晰可溯。' },
];
// 每段镜头机位：pos=相机位置，look=注视点（世界坐标）。相邻段之间平滑插值飞行。
// 设计原则：所有机位均经“对真实扫描模型做 8 向射线探针”验证——位于房间内部、与表面
// 净距≥1.0m（free）、且注视方向命中真实几何体（不空洞）。机位沿“出生点→设备簇”走廊分布，
// 注视点全部指向已验证落在模型表面的设备坐标。y 在 0.66~1.10 之间（避开横管/贴地设备）。
const TOUR_KF = [
  { pos: [2.06, 1.00, 0.00], look: [6.138, 1.289, 0.132] },    // 0 二级泵#1
  { pos: [2.52, 1.05, -0.28], look: [6.153, 1.33, 1.339] },   // 1 二级泵#2
  { pos: [2.80, 1.05, -0.45], look: [7.236, 1.755, -3.036] }, // 2 循环泵#1
  { pos: [3.10, 1.10, -0.63], look: [8.282, 1.956, -2.901] }, // 3 循环泵#2
  { pos: [3.50, 1.10, -0.83], look: [6.299, 1.934, -4.098] }, // 4 换热器
  { pos: [3.80, 1.00, -1.00], look: [7.88, 1.341, -4.914] },  // 5 补水泵#1（退至开放走廊 x≤3.8，净距≥0.5m）
  { pos: [3.80, 1.00, -1.40], look: [7.917, 1.353, -5.273] }, // 6 补水泵#2（退至开放走廊，取消低姿——低姿原假设误判，实测 y=0.66 撞设备）
  { pos: [3.80, 1.00, -2.00], look: [3.828, 2.385, -7.533] }, // 7 液位传感器（沿开放走廊 z=-2.0 通道，绕开 x4.0-4.4 设备带）
  { pos: [4.90, 1.05, -2.00], look: [4.555, 2.91, 2.616] },   // 8 热表（仰视，取 z=-2.0 开放通道避开设备带）
  { pos: [5.20, 1.00, -1.85], look: [6.299, 1.934, -4.098] }, // 9 换热器总览（未来卡）
  { pos: [5.55, 1.00, -2.05], look: [6.20, 1.60, -3.00] },    // 10 收尾（项目卡）
];
const TOUR_START = { pos: [1.83, 1.00, 0.14], look: [6.138, 1.289, 0.132] }; // 起点：出生点附近（已验证模型内、可见设备）
const TOUR_RADIUS = 1.0;  // 导览安全半径（比第一人称更保守，避免 3DGS 射线抖动）
const _tourDirs = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  _tourDirs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
}
// 把 pos 推出几何体内部/过近表面：水平 8 方向采样，用叠加斥力把相机推回开放空间；
// 相比单方向硬推，斥力场在角落/多面同时靠近时更稳定，不易来回震荡。
function clampTourPosition(pos) {
  if (!viewer || !viewer.splatMesh) return pos;
  for (let iter = 0; iter < 3; iter++) {
    let dx = 0, dz = 0, active = false;
    for (const d of _tourDirs) {
      const dist = castSplatDist(pos, d);
      if (dist < TOUR_RADIUS) {
        const pen = TOUR_RADIUS - dist;
        dx -= d.x * pen;
        dz -= d.z * pen;
        active = true;
      }
    }
    if (!active) break;
    pos.x += dx;
    pos.z += dz;
  }
  return pos;
}
const TOUR_TOTAL = TOUR_SEGS[TOUR_SEGS.length - 1].t1;

let tour = false, tourAudio = null, tourT0 = 0, tourSeg = -1, tourPicked = false;
const _pp = new THREE.Vector3(), _tp = new THREE.Vector3();
const _pl = new THREE.Vector3(), _tl = new THREE.Vector3();
const tourUI = document.getElementById('tourUI');
const tourCaption = document.getElementById('tourCaption');
const tourProg = document.getElementById('tourProg');
const futureCard = document.getElementById('futureCard');
const endCard = document.getElementById('endCard');

function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
function tourFindSeg(t) { for (let i = 0; i < TOUR_SEGS.length; i++) if (t < TOUR_SEGS[i].t1) return i; return TOUR_SEGS.length - 1; }

function setCaption(t) { if (tourCaption) tourCaption.textContent = t; }
function setTourProgress(p) { if (tourProg) tourProg.style.width = Math.max(0, Math.min(1, p)) * 100 + '%'; }
function updateTourCards(i) {
  if (futureCard) futureCard.style.display = (i === 9) ? '' : 'none';
  if (endCard) endCard.style.display = (i >= 10) ? '' : 'none';
}
// 模拟“点击拾取坐标”：在第 8 段自动落 3 个点，演示一键拾取
function doTourPicks() {
  // 拾取点指向已验证“落在模型表面”的设备坐标，确保世界坐标针脚吸附在真实设备上
  addPick([6.138, 1.289, 0.132]);   // 二级泵#1
  addPick([7.236, 1.755, -3.036]);  // 循环泵#1
  addPick([6.299, 1.934, -4.098]);  // 换热器
}

function tourUpdate() {
  if (!viewer || !viewer.camera) return;
  const t = tourAudio ? tourAudio.currentTime : (performance.now() - tourT0) / 1000;
  if ((tourAudio && tourAudio.ended) || t >= TOUR_TOTAL) { finishTour(); return; }
  const i = tourFindSeg(t);
  const s = TOUR_SEGS[i];
  const local = Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0)));
  const e = easeInOut(local);
  const prev = (i === 0) ? TOUR_START : TOUR_KF[i - 1];
  const cur = TOUR_KF[i];
  _pp.set(prev.pos[0], prev.pos[1], prev.pos[2]).lerp(_tp.set(cur.pos[0], cur.pos[1], cur.pos[2]), e);
  _pl.set(prev.look[0], prev.look[1], prev.look[2]).lerp(_tl.set(cur.look[0], cur.look[1], cur.look[2]), e);
  const cam = viewer.camera;

  // 机位已设计在走廊深处并抬高，正常情况下不会穿模；这里只做轻量保险：
  // 若插值目标点意外进入几何体/贴设备过近，朝水平最近表面反向推出一次，避免抽动。
  clampTourPosition(_pp);
  cam.position.copy(_pp);

  if (viewer.controls) viewer.controls.target.copy(_pl);
  cam.lookAt(_pl);
  if (i !== tourSeg) {
    tourSeg = i; setCaption(s.cap); updateTourCards(i);
    if (i === 8 && !tourPicked) { tourPicked = true; doTourPicks(); }
  }
  setTourProgress(t / TOUR_TOTAL);
  // 调试/自动验证用：记录每帧机位与注视点
  try {
    window.__tourState = { t: +t.toFixed(2), seg: i, pos: [cam.position.x, cam.position.y, cam.position.z].map(n => +n.toFixed(3)), look: [_pl.x, _pl.y, _pl.z].map(n => +n.toFixed(3)) };
    if (!window.__tourLog) window.__tourLog = [];
    if (window.__tourLog.length < 8000) window.__tourLog.push(window.__tourState);
  } catch (e) {}
}

function startTour() {
  if (!viewer) { setStatus('请先加载模型'); return; }
  if (!viewer.splatMesh) { setStatus('模型加载中，请稍候再试'); return; }
  // 关闭 Viewer 内置 OrbitControls 阻尼/角度限制；并【彻底接管相机】：把 controls.update
  // 替换为空操作，阻止 Viewer 渲染循环每帧回写 camera.lookAt(target) 与相机位置，
  // 从根上消除“镜头被 OrbitControls 拉回旧 target”导致的快速抽动。finishTour 时还原。
  if (viewer.controls) {
    viewer.controls.enabled = false;
    viewer.controls.enableDamping = false;
    viewer.controls.minPolarAngle = 0;
    viewer.controls.maxPolarAngle = Math.PI;
    if (!viewer.__origControlsUpdate) viewer.__origControlsUpdate = viewer.controls.update.bind(viewer.controls);
    viewer.controls.update = function () {};
  }
  // 清场，保证演示干净
  worldPins.forEach(p => p.el.remove()); worldPins = []; picks = []; pinSeq = 1; renderPicks();
  tour = true; tourSeg = -1; tourPicked = false; tourT0 = performance.now();
  roam = false; pickMode = false; if (pickChk) pickChk.checked = false; viewerEl.style.cursor = '';
  roamHelp.classList.remove('show');
  if (pickPanel) pickPanel.classList.add('hidden'); // 导览时收起拾取面板，避免遮挡画面
  if (tourUI) tourUI.classList.remove('hidden');
  setCaption(TOUR_SEGS[0].cap); updateTourCards(0); setTourProgress(0);
  // 尝试加载并同步播放旁白；文件缺失则退化为纯时间轴（无配音）
  if (!tourAudio) {
    tourAudio = new Audio('./tour-audio.mp3');
    tourAudio.preload = 'auto';
  }
  tourAudio.currentTime = 0;
  const p = tourAudio.play();
  if (p && p.catch) p.catch(() => { setStatus('未检测到旁白音频，将以静音时间轴播放导览'); });
  setStatus('自动导览中：镜头正沿轨道按文案展示功能…');
}

function finishTour() {
  if (tour === false) return;   // 防止音频 ended 与 tick 重复触发
  tour = false;
  // 还原 OrbitControls.update（导览期间被替换为空操作）
  if (viewer && viewer.controls && viewer.__origControlsUpdate) {
    viewer.controls.update = viewer.__origControlsUpdate;
    viewer.__origControlsUpdate = null;
  }
  if (tourAudio) { try { tourAudio.pause(); } catch (e) {} }
  if (tourUI) tourUI.classList.add('hidden');
  if (pickPanel) pickPanel.classList.remove('hidden'); // 导览结束恢复拾取面板
  updateTourCards(-1);
  enterRoam();   // 回到第一人称，从导览结束的机位继续操作
  setStatus('导览结束，已回到第一人称（碰撞已开启）');
}

document.getElementById('tourBtn').onclick = startTour;
document.getElementById('tourReplay').onclick = () => {
  worldPins.forEach(p => p.el.remove()); worldPins = []; picks = []; pinSeq = 1; renderPicks();
  tourSeg = -1; tourPicked = false; tourT0 = performance.now();
  tour = true; roam = false; pickMode = false; if (pickChk) pickChk.checked = false; viewerEl.style.cursor = '';
  // 重新接管相机（与 startTour 一致）
  if (viewer && viewer.controls) {
    if (!viewer.__origControlsUpdate) viewer.__origControlsUpdate = viewer.controls.update.bind(viewer.controls);
    viewer.controls.update = function () {};
    viewer.controls.enabled = false;
  }
  if (tourUI) tourUI.classList.remove('hidden');
  if (pickPanel) pickPanel.classList.add('hidden');
  setCaption(TOUR_SEGS[0].cap); updateTourCards(0); setTourProgress(0);
  if (tourAudio) { tourAudio.currentTime = 0; const pp = tourAudio.play(); if (pp && pp.catch) pp.catch(() => {}); }
  setStatus('重新播放导览…');
};
document.getElementById('tourExit').onclick = finishTour;
if (tourAudio) tourAudio.addEventListener('ended', () => { if (tour && tourAudio.currentTime >= TOUR_TOTAL - 0.05) finishTour(); });

// ---------- 模型控制按钮 ----------
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadSplat(URL.createObjectURL(f), f.name); });
document.getElementById('loadBtn').onclick = () => fileInput.click();
document.getElementById('realBtn').onclick = () => loadSplat('https://huanrezhanshuzi-1474677827.cos.ap-beijing.myqcloud.com/xinminyuan.ply', '新民园 真实3DGS（已摆正）', { pos: SPAWN, look: SPAWN_LOOK }, { rotation: [1, 0, 0, 0], position: [0, 0.9295, 0] });
document.getElementById('resetBtn').onclick = () => {
  if (!viewer || !viewer.camera || !lastCam) { setStatus('请先加载模型'); return; }
  viewer.camera.position.set(lastCam.pos[0], lastCam.pos[1], lastCam.pos[2]);
  enterRoam();                              // 重新进入第一人称并朝向出生方向
  setStatus('已回到出生点');
};

// ---------- 拖拽加载 ----------
viewerEl.addEventListener('dragover', e => { e.preventDefault(); dropHint.classList.add('show'); });
viewerEl.addEventListener('dragleave', () => dropHint.classList.remove('show'));
viewerEl.addEventListener('drop', e => {
  e.preventDefault(); dropHint.classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (f && /\.(ply|splat|ksplat|spz)$/i.test(f.name)) loadSplat(URL.createObjectURL(f), f.name);
});

// ---------- 启动默认加载（保留模型显示，出生点 #1） ----------
loadSplat('https://huanrezhanshuzi-1474677827.cos.ap-beijing.myqcloud.com/xinminyuan.ply', '新民园 真实3DGS（137万点，已摆正）', { pos: SPAWN, look: SPAWN_LOOK }, { rotation: [1, 0, 0, 0], position: [0, 0.9295, 0] });
