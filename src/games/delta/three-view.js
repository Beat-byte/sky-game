/**
 * 「危险行动」第一人称视图：Three.js 的 WebGL 绑定层。
 *
 * 分工与俯视一致：**只读引擎状态往画布上画，绝不改状态**。几何与相机数学全部来自
 * scene3d.js（纯函数、可单测），这里只做"把规格变成 three 对象并每帧同步"。
 *
 * 三条约束：
 * 1. 视场角走 cameraConfig(aspect)：1:1 与宽屏锁水平 75°，竖屏改夹垂直角（见 scene3d.js）；
 * 2. 不用 Math.random：抖动、步态、火光全部由格号 / 实体 id / 传入的 phase 派生；
 * 3. 静态盒子按类型合成 InstancedMesh（一张图 7 个左右 draw call），手机端才跑得动。
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { FIGURE_M, FIGURE_TONE, EXFIL, VIEWMODEL, buildSceneSpec, cameraConfig, eyePose, yawFor } from "./scene3d.js";
import { WORLD } from "./map.js";

/** 手机 WebGL 的像素比上限：2.5 倍分辨率的填充率不值得，1.5 在 720p 屏上已经不糊 */
const MAX_DPR = 1.5;

function hashJitter(x, y, salt = 0) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 2×2 棋盘纹理：贴一次盖两格，NearestFilter 保住格子边缘不发虚（花纹与俯视双色棋盘同源） */
function makeGroundTexture(ground) {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx2 = canvas.getContext("2d");
  const hex = (value) => `#${value.toString(16).padStart(6, "0")}`;
  ctx2.fillStyle = hex(ground.base);
  ctx2.fillRect(0, 0, 2, 2);
  ctx2.fillStyle = hex(ground.alt);
  ctx2.fillRect(0, 0, 1, 1);
  ctx2.fillRect(1, 1, 1, 1);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function boxMesh(size, color, { transparent = false, opacity = 1 } = {}) {
  const geometry = new BoxGeometry(size[0], size[1], size[2]);
  const material = new MeshLambertMaterial({ color, transparent, opacity });
  return new Mesh(geometry, material);
}

/**
 * 建一个第一人称视图。返回 { sync, render, resize, dispose, ok }。
 * WebGL 起不来（老设备/无 GPU/上下文丢失）时构造函数直接抛，由装配层退回俯视图。
 */
export function createThreeView({ canvas, map }) {
  const spec = buildSceneSpec(map);
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio ?? 1));

  const scene = new Scene();
  scene.fog = new Fog(spec.fog.color, spec.fog.near, spec.fog.far);
  // 天空直接用雾色：清屏色默认是纯黑，抬头或越过墙顶就会看见一块死黑，
  // 夜间实测整屏 4% 是 rgb(0,0,0)。雾和天空同色，远处才有"越远越淡"的连续过渡。
  scene.background = new Color(spec.fog.color);

  const cam0 = cameraConfig(1);
  const camera = new PerspectiveCamera(cam0.fov, cam0.aspect, cam0.near, cam0.far);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  const disposables = [];
  const track = (item) => {
    disposables.push(item);
    return item;
  };

  // 地面：一张 plane + 棋盘纹理按格重复，比几万块地砖省得多
  const groundTexture = makeGroundTexture(spec.ground);
  groundTexture.repeat.set(Math.max(1, spec.bounds.cols / 2), Math.max(1, spec.bounds.rows / 2));
  const groundGeo = track(new PlaneGeometry(spec.bounds.width, spec.bounds.height));
  const groundMat = track(new MeshLambertMaterial({ map: groundTexture }));
  const ground = new Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(spec.bounds.width / 2, 0, spec.bounds.height / 2);
  scene.add(ground);
  track(groundTexture);

  const hemi = new HemisphereLight(spec.lights.hemi.sky, spec.lights.hemi.ground, spec.lights.hemi.intensity);
  scene.add(hemi);
  const sun = new DirectionalLight(spec.lights.sun.color, spec.lights.sun.intensity);
  sun.position.set(spec.lights.sun.dir[0] * 20, 20 * spec.lights.sun.dir[1], spec.lights.sun.dir[2] * 20);
  scene.add(sun);

  // 静态盒子：每种一类一个 InstancedMesh
  const dummy = new Object3D();
  const staticMeshes = [];
  const byKind = new Map();
  function buildList(list, keyPrefix) {
    for (const group of list) {
      const geometry = track(new BoxGeometry(group.size[0], group.size[1], group.size[2]));
      const material = track(new MeshLambertMaterial({ color: group.color }));
      const mesh = new InstancedMesh(geometry, material, Math.max(1, group.items.length));
      group.items.forEach((item, index) => {
        dummy.position.set(item.x, item.y, item.z);
        dummy.rotation.set(0, item.ry, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      // count 就是实际实例数：容量按 max(1,n) 申请，多余容量不画，不会冒出"图外幽灵盒"
      mesh.count = group.items.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData.kind = keyPrefix + group.kind;
      scene.add(mesh);
      staticMeshes.push(mesh);
      byKind.set(keyPrefix + group.kind, mesh);
      disposables.push(mesh);
    }
  }
  buildList(spec.groups, "");
  // 形状提示层（矮容器的亮顶盖 / 墙体的视线带）走同一套实例化，draw call 只多 7 次左右
  buildList(spec.marks ?? [], "mark:");

  // 撤离点信标每帧发光脉动，材质留着改
  const beaconMesh = byKind.get("exfil-beacon") ?? null;

  const figures = new Map();
  const torsoGeo = track(new BoxGeometry(FIGURE_M.torso.size[0], FIGURE_M.torso.size[1], FIGURE_M.torso.size[2]));
  const headGeo = track(new BoxGeometry(FIGURE_M.head.size[0], FIGURE_M.head.size[1], FIGURE_M.head.size[2]));
  const legsGeo = track(new BoxGeometry(FIGURE_M.legs.size[0], FIGURE_M.legs.size[1], FIGURE_M.legs.size[2]));

  function obtainFigure(id) {
    if (figures.has(id)) return figures.get(id);
    const group = new Group();
    const parts = {
      torso: new Mesh(torsoGeo, track(new MeshLambertMaterial({ color: FIGURE_TONE.unseen.body }))),
      head: new Mesh(headGeo, track(new MeshLambertMaterial({ color: FIGURE_TONE.unseen.head }))),
      legs: new Mesh(legsGeo, track(new MeshLambertMaterial({ color: FIGURE_TONE.unseen.legs }))),
    };
    parts.torso.position.y = FIGURE_M.torso.y;
    parts.head.position.y = FIGURE_M.head.y;
    parts.legs.position.y = FIGURE_M.legs.y;
    group.add(parts.torso, parts.head, parts.legs);
    scene.add(group);
    const entry = { key: id, group, parts };
    figures.set(id, entry);
    return entry;
  }

  // 活体配色抽在 scene3d.js（纯数据、可单测）：红/橙/紫与场景的冷灰、木棕、金、青、柠檬全部错开
  const paletteFor = FIGURE_TONE;

  const bags = [];
  const bagGeo = track(new BoxGeometry(0.42, 0.28, 0.34));
  const bagMat = track(new MeshLambertMaterial({ color: 0x8b6f47 }));
  for (let i = 0; i < WORLD.maxGroundBags; i += 1) {
    const mesh = new Mesh(bagGeo, bagMat);
    mesh.visible = false;
    scene.add(mesh);
    bags.push(mesh);
  }

  const smokes = [];
  const smokeGeo = track(new SphereGeometry(1, 12, 8));
  for (let i = 0; i < 4; i += 1) {
    const mesh = new Mesh(smokeGeo, track(new MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.45 })));
    mesh.visible = false;
    scene.add(mesh);
    smokes.push(mesh);
  }

  const tracers = [];
  const tracerGeo = track(new BoxGeometry(0.07, 0.07, 0.6));
  const tracerMatPlayer = track(new MeshBasicMaterial({ color: 0xffecb4 }));
  const tracerMatAi = track(new MeshBasicMaterial({ color: 0xff9696 }));
  for (let i = 0; i < WORLD.maxBullets; i += 1) {
    const mesh = new Mesh(tracerGeo, i % 2 === 0 ? tracerMatPlayer : tracerMatAi);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push(mesh);
  }

  // 第一人称枪模挂在相机上：转弯/低头时跟着眼睛走，才有"手里有枪"的锚点
  const rig = new Group();
  camera.add(rig);
  const rigParts = [];
  for (const key of ["body", "barrel", "mag"]) {
    const mesh = boxMesh(VIEWMODEL[key].size, VIEWMODEL[key].color);
    mesh.position.set(VIEWMODEL[key].pos[0], VIEWMODEL[key].pos[1], VIEWMODEL[key].pos[2]);
    rig.add(mesh);
    rigParts.push(mesh);
    disposables.push(mesh.geometry, mesh.material);
  }
  for (const hand of VIEWMODEL.hands) {
    const mesh = boxMesh(hand.size, hand.color);
    mesh.position.set(hand.pos[0], hand.pos[1], hand.pos[2]);
    rig.add(mesh);
    rigParts.push(mesh);
    disposables.push(mesh.geometry, mesh.material);
  }
  const flashGeo = track(new SphereGeometry(VIEWMODEL.muzzle.radius, 8, 6));
  const flashMat = track(new MeshBasicMaterial({ color: 0xffdc8c, transparent: true, opacity: 0.9 }));
  const flash = new Mesh(flashGeo, flashMat);
  flash.position.set(VIEWMODEL.muzzle.pos[0], VIEWMODEL.muzzle.pos[1], VIEWMODEL.muzzle.pos[2]);
  flash.visible = false;
  rig.add(flash);
  const muzzleLight = new PointLight(0xffd08a, 0, 6, 2);
  muzzleLight.position.copy(flash.position);
  camera.add(muzzleLight);

  let aspect = 1;

  function applyAspect(next) {
    const cfg = cameraConfig(next);
    aspect = cfg.aspect;
    camera.fov = cfg.fov;
    camera.aspect = cfg.aspect;
    camera.near = cfg.near;
    camera.far = cfg.far;
    camera.updateProjectionMatrix();
  }

  function resize(css) {
    const width = Math.max(1, Math.round(css.width));
    const height = Math.max(1, Math.round(css.height));
    renderer.setSize(width, height, false);
    applyAspect(width / height);
  }

  function sync(game, { phase = 0 } = {}) {
    const p = game.player;
    const magnitude = Math.hypot(game.stick.x, game.stick.y);
    const pose = eyePose({ angle: p.angle, magnitude, phase });
    camera.position.set(p.x, pose.eyeY + pose.bob, p.y);
    camera.rotation.set(pose.pitch, pose.yaw, pose.roll);

    rig.visible = p.alive;
    const kick = game.fx.muzzle && game.fx.muzzle.owner === 0 && game.fx.muzzle.ttl > 0 ? Math.min(1, game.fx.muzzle.ttl * 8) : 0;
    rig.position.z = kick * 0.06;
    flash.visible = kick > 0;
    if (kick > 0) {
      const size = 0.6 + kick;
      flash.scale.set(size, size, size);
      flashMat.opacity = 0.9 * kick;
    }
    muzzleLight.intensity = kick * 1.4;

    const pulsed = game.pulse.ttl > 0;
    const used = new Set();
    for (const ai of game.ais) {
      if (!ai.alive || ai.isGhost) continue;
      /**
       * 俯视是"上帝视角"，敌人一律画出来；第一人称不能隔着墙看见人，
       * 所以这里改用引擎同一个 visible()（只读）做一次可视性裁剪：
       * 看得见、或脉冲正在标记，才立起这个人形。
       */
      const revealed = pulsed || game.visible({ x: p.x, y: p.y }, { x: ai.x, y: ai.y });
      if (!revealed) continue;
      const entry = obtainFigure(ai.id);
      used.add(ai.id);
      const tone = ai.state === "engage" && ai.sees ? paletteFor.engage : ai.sees ? paletteFor.alert : paletteFor.unseen;
      entry.parts.torso.material.color.setHex(tone.body);
      entry.parts.head.material.color.setHex(pulsed ? 0x4ac1ff : tone.head);
      entry.parts.legs.material.color.setHex(tone.legs);
      const swing = Math.sin(phase * 8.5 + hashJitter(ai.id, 0, 11) * Math.PI * 2) * Math.min(1, Math.hypot(ai.intent?.moveX ?? 0, ai.intent?.moveY ?? 0));
      entry.group.position.set(ai.x, 0, ai.y);
      entry.group.rotation.y = yawFor(ai.angle);
      entry.group.rotation.z = swing * 0.06;
      entry.group.visible = true;
      entry.parts.legs.position.x = swing * 0.12;
    }
    for (const entry of figures.values()) {
      if (!used.has(entry.key)) entry.group.visible = false;
    }

    let bagIndex = 0;
    for (const bag of game.groundBags) {
      if (bagIndex >= bags.length) break;
      const mesh = bags[bagIndex];
      mesh.visible = true;
      mesh.position.set(bag.x, 0.14, bag.y);
      mesh.rotation.y = hashJitter(Math.floor(bag.x), Math.floor(bag.y), 13) * Math.PI;
      bagIndex += 1;
    }
    for (let i = bagIndex; i < bags.length; i += 1) bags[i].visible = false;

    let smokeIndex = 0;
    for (const smoke of game.smokes) {
      if (smoke.ttl <= 0 || smokeIndex >= smokes.length) continue;
      const mesh = smokes[smokeIndex];
      const ratio = Math.min(1, smoke.ttl / 2);
      mesh.visible = true;
      mesh.position.set(smoke.x, smoke.r * 0.55, smoke.y);
      mesh.scale.set(smoke.r, smoke.r * 0.7, smoke.r);
      mesh.material.opacity = 0.55 * ratio;
      smokeIndex += 1;
    }
    for (let i = smokeIndex; i < smokes.length; i += 1) smokes[i].visible = false;

    let tracerIndex = 0;
    for (const bullet of game.bullets.items) {
      if (!bullet.alive || tracerIndex >= tracers.length) continue;
      const mesh = tracers[tracerIndex];
      mesh.visible = true;
      mesh.material = bullet.owner === 0 ? tracerMatPlayer : tracerMatAi;
      const midX = (bullet.px + bullet.x) / 2;
      const midZ = (bullet.py + bullet.y) / 2;
      mesh.position.set(midX, 1.35, midZ);
      mesh.rotation.y = yawFor(Math.atan2(bullet.y - bullet.py, bullet.x - bullet.px));
      const length = Math.max(0.2, Math.hypot(bullet.x - bullet.px, bullet.y - bullet.py) * 2.4);
      mesh.scale.set(1, 1, length);
      tracerIndex += 1;
    }
    for (let i = tracerIndex; i < tracers.length; i += 1) tracers[i].visible = false;

    if (beaconMesh) {
      const beat = 0.55 + 0.45 * Math.sin(phase * 3.1);
      beaconMesh.material.emissive?.setHex?.(EXFIL.beacon.color);
      beaconMesh.material.emissiveIntensity = beat;
    }
  }

  function render() {
    renderer.render(scene, camera);
  }

  function dispose() {
    for (const entry of figures.values()) scene.remove(entry.group);
    figures.clear();
    for (const mesh of staticMeshes) scene.remove(mesh);
    for (const item of disposables) item.dispose?.();
    for (const mesh of scene.children) mesh.traverse?.((child) => child.material?.dispose?.());
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return {
    sync,
    render,
    resize,
    dispose,
    get aspect() { return aspect; },
    spec,
    /** 绘制回执：验证脚本要能证明"这一帧真的画到了这张画布上"（calls=0 就是没画） */
    info: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      domElement: renderer.domElement,
      size: renderer.getSize(new Vector2()),
      dpr: renderer.getPixelRatio(),
      children: scene.children.length,
      lights: scene.children.filter((child) => child.isLight).length,
      clearColor: `#${renderer.getClearColor(new Color()).getHex().toString(16)}`,
      clearAlpha: renderer.getClearAlpha(),
      cam: {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        quat: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
        worldPos: (() => { const v = camera.getWorldPosition(new Vector3()); return [v.x, v.y, v.z]; })(),
        forward: (() => { const v = camera.getWorldDirection(new Vector3()); return [v.x, v.y, v.z]; })(),
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
      },
    }),
  };
}
