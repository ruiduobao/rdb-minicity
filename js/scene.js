
// 场景层：手写几何构建（建筑拉伸、道路带、水面、绿地、底座）。
import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/addons/controls/OrbitControls.js";
import { createLocalProjector } from "./proj.js";

function shapeFromPolygon(pts) {
  const shape = new THREE.Shape();
  pts.forEach(([x, z], i) => { const y = -z; if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  return shape;
}
function centroid(pts) {
  let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}
// 道路带：逐段按法线偏移生成三角带，自己实现，不依赖任何现成库函数
function roadRibbon(line, width, y) {
  const pos = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [x1, z1] = line[i], [x2, z2] = line[i + 1];
    const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width / 2, nz = (dx / len) * width / 2;
    const a = [x1 + nx, z1 + nz], b = [x1 - nx, z1 - nz], c = [x2 + nx, z2 + nz], d = [x2 - nx, z2 - nz];
    pos.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1], b[0], y, b[1], d[0], y, d[1], c[0], y, c[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
const ROAD_WIDTH = { motorway: 14, trunk: 13, primary: 12, secondary: 10, tertiary: 8, residential: 6, service: 4, footway: 2, path: 2, pedestrian: 5 };

export function createMiniCity(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const aspect = () => (container.clientWidth || 800) / (container.clientHeight || 600);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ambient = new THREE.AmbientLight(0xffffff, 0.8); scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun); scene.add(sun.target);

  let cityGroup = null, theme = null, sizeM = 400;
  let pickables = []; // 可拾取建筑网格（点击查看名称/高度用）

  function setView({ azimuth = 45, polar = 52, distance = 620 } = {}) {
    const az = azimuth * Math.PI / 180, pol = polar * Math.PI / 180;
    camera.position.set(distance * Math.sin(pol) * Math.sin(az), distance * Math.cos(pol), distance * Math.sin(pol) * Math.cos(az));
    camera.lookAt(0, 0, 0); controls.target.set(0, 0, 0); controls.update();
  }
  function getView() {
    const p = camera.position, d = p.length();
    return { azimuth: Math.atan2(p.x, p.z) * 180 / Math.PI, polar: Math.acos(p.y / d) * 180 / Math.PI, distance: d };
  }
  function frameCamera() {
    const half = sizeM * 0.78, a = aspect();
    camera.left = -half * a; camera.right = half * a; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();
  }
  function resize() {
    renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    frameCamera();
  }

  function build(data, center, size, th, buildOpts = {}) {
    theme = th; sizeM = size;
    if (cityGroup) { scene.remove(cityGroup); cityGroup.traverse(o => { o.geometry?.dispose?.(); }); }
    cityGroup = new THREE.Group();
    scene.background = new THREE.Color(th.bg);
    scene.fog = new THREE.Fog(th.fog, 1200, 2600);
    ambient.intensity = th.ambient; ambient.color.set(th.light);
    sun.intensity = th.sun; sun.color.set(th.light);
    sun.position.set(size * 0.7, size * 0.9, size * 0.35);
    const sc = size * 1.2;
    Object.assign(sun.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc, far: 3000 });
    sun.shadow.camera.updateProjectionMatrix();

    const proj = createLocalProjector(center.lon, center.lat);
    const P = ring => ring.map(([lon, lat]) => { const p = proj.project(lon, lat); return [p.x, p.z]; });
    const half = size / 2;

    // 底座：两层方形基座，营造微缩模型感
    const baseMat = new THREE.MeshStandardMaterial({ color: th.base, roughness: 0.95 });
    const sideMat = new THREE.MeshStandardMaterial({ color: th.baseSide, roughness: 1 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(size * 1.04, 10, size * 1.04), sideMat);
    base.position.y = -5.2; base.receiveShadow = true; cityGroup.add(base);
    const ground = new THREE.Mesh(new THREE.BoxGeometry(size, 2, size), [sideMat, baseMat, sideMat, sideMat, sideMat, sideMat]);
    ground.position.y = -1; ground.receiveShadow = true; cityGroup.add(ground);
    const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 }));
    groundPlane.rotation.x = -Math.PI / 2; groundPlane.position.y = 0.02; groundPlane.receiveShadow = true; cityGroup.add(groundPlane);

    const edgeMat = new THREE.LineBasicMaterial({ color: th.edge, transparent: true, opacity: 0.35 });
    const roofMat = new THREE.MeshStandardMaterial({ color: th.roof, roughness: 0.9 });
    const mats = th.buildings.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));

    pickables = [];
    data.buildings.forEach((b, idx) => {
      const pts = P(b.polygon); if (pts.length < 4) return;
      const h = Math.max(3, Math.min(220, b.height || 10));
      try {
        const geo = new THREE.ExtrudeGeometry(shapeFromPolygon(pts), { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, mats[idx % mats.length]);
        mesh.castShadow = true; mesh.receiveShadow = true; cityGroup.add(mesh);
        mesh.userData.building = {
          name: (b.tags && (b.tags.name || b.tags["name:zh"])) || "",
          height: Math.round(h * 10) / 10,
          heightSource: b.heightSource || "估算",
          levels: (b.tags && b.tags["building:levels"]) || "",
          type: (b.tags && b.tags.building) || "",
        };
        pickables.push(mesh);
        // 屋顶略收分：向质心收缩 8% 的薄顶盖
        const [cx, cz] = centroid(pts);
        const roofPts = pts.map(([x, z]) => [cx + (x - cx) * 0.92, cz + (z - cz) * 0.92]);
        const roof = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromPolygon(roofPts)), roofMat);
        roof.rotation.x = -Math.PI / 2; roof.position.y = h + 0.06; cityGroup.add(roof);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat); cityGroup.add(edges);
      } catch { /* 个别自交多边形跳过 */ }
    });

    const roadMat = new THREE.MeshStandardMaterial({ color: th.road, roughness: 1 });
    for (const r of data.roads) {
      const pts = P(r.line); if (pts.length < 2) continue;
      const mesh = new THREE.Mesh(roadRibbon(pts, ROAD_WIDTH[r.highway] || 6, 0.18), roadMat);
      mesh.receiveShadow = true; cityGroup.add(mesh);
    }
    const waterMat = new THREE.MeshStandardMaterial({ color: th.water, roughness: 0.25, transparent: true, opacity: 0.82 });
    for (const wgeo of data.waters) {
      if (wgeo.polygon) {
        const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromPolygon(P(wgeo.polygon))), waterMat);
        m.rotation.x = -Math.PI / 2; m.position.y = 0.3; cityGroup.add(m);
      } else if (wgeo.line) cityGroup.add(new THREE.Mesh(roadRibbon(P(wgeo.line), 6, 0.28), waterMat));
    }
    const greenMat = new THREE.MeshStandardMaterial({ color: th.green, roughness: 1 });
    for (const g of data.greens) {
      if (!g.polygon) continue;
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromPolygon(P(g.polygon))), greenMat);
      m.rotation.x = -Math.PI / 2; m.position.y = 0.12; m.receiveShadow = true; cityGroup.add(m);
    }
    scene.add(cityGroup);
    frameCamera();
    if (!buildOpts.keepView) setView(buildOpts.view || {});
    renderer.render(scene, camera);
    return data.stats;
  }

  // 高清导出：离屏放大渲染后合成水印
  async function exportPNG(px = 2048, { pro = false } = {}) {
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    renderer.setSize(px, Math.round(px * h / w), false);
    const prevHalf = camera.top;
    // 保持构图：按导出宽高比重设正交相机
    const a = px / Math.round(px * h / w), half = sizeM * 0.78;
    camera.left = -half * a; camera.right = half * a; camera.top = half; camera.bottom = -half; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const out = document.createElement("canvas"); out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d"); ctx.drawImage(src, 0, 0);
    if (!pro) {
      // 品牌水印：与品牌标一致的深黛蓝圆角底 + 白字 + 朱砂定位点
      const label = "RDB MiniCity · 锐多宝出品";
      const fs = Math.max(20, Math.round(out.width * 0.016));
      ctx.font = `600 ${fs}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = Math.round(fs * 0.7), dotR = Math.round(fs * 0.28);
      const bw = tw + pad * 2 + dotR * 2 + 10, bh = Math.round(fs * 1.9);
      const bx = out.width - bw - 28, by = out.height - bh - 28;
      ctx.fillStyle = "rgba(23,63,95,0.92)"; // 深黛蓝 #173F5F
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, Math.round(bh / 3)); ctx.fill(); }
      else ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = "#C8442C"; // 朱砂定位点
      ctx.beginPath(); ctx.arc(bx + pad + dotR, by + bh / 2, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#2E7D6B"; // 青绿点缀（点心）
      ctx.beginPath(); ctx.arc(bx + pad + dotR, by + bh / 2, dotR * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + pad + dotR * 2 + 10, by + bh / 2 + 1);
      ctx.textBaseline = "alphabetic";
    }
    resize(); renderer.render(scene, camera);
    return new Promise(res => out.toBlob(b => res({ blob: b, width: out.width, height: out.height }), "image/png"));
  }

  // 点击拾取：把容器内像素坐标换算为 NDC 后射线求交，返回最近建筑的信息或 null
  function pickAt(clientX, clientY) {
    if (!pickables.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    return hits.length ? { ...hits[0].object.userData.building } : null;
  }

  const onResize = () => resize(); addEventListener("resize", onResize);
  resize(); setView(opts.view || {});
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
  return { build, setView, getView, exportPNG, resize, pickAt,
    dispose() { removeEventListener("resize", onResize); renderer.dispose(); container.innerHTML = ""; } };
}
