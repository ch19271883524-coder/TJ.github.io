import * as THREE from 'three';
import * as GaussianSplats3D from '/TJ.github.io/heatstation/node_modules/@mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js';

window.__three = THREE;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const fileInput = document.getElementById('file');
const worldPinsEl = document.getElementById('worldPins');
const pkList = document.getElementById('pkList');
const dropHint = document.getElementById('drop-hint');
const fpsEl = document.getElementById('fps');
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
const _pickHits = [];
const RENDER_DPR = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
const SPAWN = [1.826, 0.635, 0.135]; // 用户标记点(0.297,0.635,-1.156)沿水平视线后退 2m，避免相机嵌进近场
const SPAWN_LOOK = [-9, 5, -9];

function setStatus(t) { statusEl.textContent = t; }

// ---------- 加载模型（编辑器核心：支持任意 .ply/.splat/.ksplat/.spz） ----------
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
    try { if (viewer.renderer) viewer.renderer.setClearColor(0xeef1f6, 1); if (viewer.scene) viewer.scene.background = new THREE.Color(0xeef1f6); } catch (e) {}
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
  if (roam && viewer && viewer.camera) roamMove();   // 编辑器：无导览，仅第一人称
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
  const el = document.createElement('div'); el.className = 'wpin'; el.dataset.pid = id; el.style.setProperty('--c', '#2f6fed');
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

// ---------- 模型控制按钮 ----------
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadSplat(URL.createObjectURL(f), f.name); });
document.getElementById('loadBtn').onclick = () => fileInput.click();
// “载入示例”：一键加载示例高斯模型（编辑器不默认加载任何模型，需用户主动载入）
document.getElementById('realBtn').onclick = () => loadSplat('https://huanrezhanshuzi-1474677827.cos.ap-beijing.myqcloud.com/xinminyuan.ply', '示例 3DGS（已摆正）', { pos: SPAWN, look: SPAWN_LOOK }, { rotation: [1, 0, 0, 0], position: [0, 0.9295, 0] });
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

// 编辑器模式：不自动加载任何模型，打开即空画布，由用户拖拽/选择/载入示例。
