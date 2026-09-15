import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const DEFAULT_COLORS = [0x4c9aff, 0x50c79d, 0xf0a347, 0xaa84ea, 0xe96b7a, 0x61b8da];

export class CadViewer {
  constructor(canvas, { onSelect = () => {}, onStats = () => {} } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.onStats = onStats;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f15);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.perspectiveCamera = new THREE.PerspectiveCamera(38, 1, 0.01, 100000);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
    this.camera = this.perspectiveCamera;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => this.render());

    this.root = null;
    this.partObjects = new Map();
    this.meshToPart = new Map();
    this.selectedPartId = null;
    this.ghostMode = false;
    this.wireframe = false;
    this.reviewOpacity = new Map();
    this.viewPreset = "free";
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.animationFrame = 0;
    this.partIds = [];
    this.loadSequence = 0;

    this.addEnvironment();
    this.handlePointer = (event) => this.pick(event);
    canvas.addEventListener("click", this.handlePointer);
    this.resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.resize())
      : null;
    this.resizeObserver?.observe(canvas);
    this.resize();
    this.animate();
  }

  addEnvironment() {
    this.scene.add(new THREE.HemisphereLight(0xc9ddff, 0x182231, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, -5, 8);
    key.castShadow = true;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x77aaff, 1.4);
    fill.position.set(-5, 3, 2);
    this.scene.add(fill);
    this.grid = new THREE.GridHelper(2000, 80, 0x36506f, 0x1d2a3a);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(45);
    this.scene.add(this.axes);
  }

  async loadGlb(url, { parts = [], label = "装配 GLB" } = {}) {
    const sequence = ++this.loadSequence;
    let gltf;
    try {
      gltf = await new GLTFLoader().loadAsync(url);
    } catch (error) {
      if (sequence !== this.loadSequence) return null;
      throw error;
    }
    if (sequence !== this.loadSequence) {
      this.disposeObject(gltf.scene);
      return null;
    }
    this.clearModel();
    this.partIds = parts.map((part) => String(part.id));
    this.root = gltf.scene;
    this.root.name ||= "assembly";
    this.scene.add(this.root);
    this.indexParts(parts);
    this.decorateMeshes();
    this.resize();
    this.fitToObject(this.root);
    this.emitStats(label, "GLB");
    this.render();
    return this.stats();
  }

  async loadStl(url, { label = "STL 兼容模式", partId = null } = {}) {
    const sequence = ++this.loadSequence;
    let geometry;
    try {
      geometry = await new STLLoader().loadAsync(url);
    } catch (error) {
      if (sequence !== this.loadSequence) return null;
      throw error;
    }
    if (sequence !== this.loadSequence) {
      geometry.dispose();
      return null;
    }
    this.clearModel();
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLORS[0], roughness: 0.62, metalness: 0.18 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = partId || "stl_model";
    mesh.userData.partId = partId;
    this.root = new THREE.Group();
    this.root.add(mesh);
    this.scene.add(this.root);
    if (partId) {
      this.partObjects.set(partId, mesh);
      this.meshToPart.set(mesh, partId);
    }
    this.decorateMeshes();
    this.resize();
    this.fitToObject(this.root);
    this.emitStats(label, "STL");
    this.render();
    return this.stats();
  }

  indexParts(parts) {
    const normalized = new Map(parts.map((part) => [this.normalizeName(part.id), String(part.id)]));
    this.root.traverse((object) => {
      if (!object.isObject3D) return;
      const key = this.normalizeName(object.name);
      const exact = normalized.get(key);
      const fuzzy = exact || [...normalized].find(([candidate]) => key.includes(candidate) || candidate.includes(key))?.[1];
      if (fuzzy && !this.partObjects.has(fuzzy)) this.partObjects.set(fuzzy, object);
    });
    for (const [partId, object] of this.partObjects) {
      object.traverse((child) => {
        if (!child.isMesh) return;
        child.userData.partId = partId;
        this.meshToPart.set(child, partId);
      });
    }
  }

  decorateMeshes() {
    let meshIndex = 0;
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.geometry.computeVertexNormals();
      const source = Array.isArray(object.material) ? object.material[0] : object.material;
      object.material = new THREE.MeshStandardMaterial({
        color: source?.color?.clone() || new THREE.Color(DEFAULT_COLORS[meshIndex % DEFAULT_COLORS.length]),
        roughness: 0.6,
        metalness: 0.16,
        side: THREE.DoubleSide
      });
      object.userData.originalMaterial = object.material.clone();
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(object.geometry, 24),
        new THREE.LineBasicMaterial({ color: 0x26384d, transparent: true, opacity: 0.72 })
      );
      edges.name = "__cad_edges__";
      object.add(edges);
      meshIndex += 1;
    });
  }

  normalizeName(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  }

  pick(event) {
    if (!this.root) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find((item) => item.object.isMesh && item.object.userData.partId);
    if (hit) this.selectPart(hit.object.userData.partId, { notify: true });
  }

  selectPart(partId, { frame = false, notify = false } = {}) {
    const next = partId && this.partObjects.has(String(partId)) ? String(partId) : null;
    this.selectedPartId = next;
    this.applyAppearance();
    if (frame && next) this.fitToObject(this.partObjects.get(next), 1.65);
    if (notify) this.onSelect(next);
    this.emitStats();
    this.render();
    return Boolean(next);
  }

  hideSelected() {
    if (!this.selectedPartId) return false;
    this.partObjects.get(this.selectedPartId).visible = false;
    this.selectedPartId = null;
    this.onSelect(null);
    this.applyAppearance();
    this.render();
    return true;
  }

  isolateSelected() {
    if (!this.selectedPartId) return false;
    for (const [partId, object] of this.partObjects) object.visible = partId === this.selectedPartId;
    this.render();
    return true;
  }

  showAll() {
    for (const object of this.partObjects.values()) object.visible = true;
    this.applyAppearance();
    this.render();
  }

  captureDisplayState() {
    return {
      selectedPartId: this.selectedPartId,
      ghostMode: this.ghostMode,
      wireframe: this.wireframe,
      viewPreset: this.viewPreset,
      cameraType: this.camera === this.orthoCamera ? "ortho" : "perspective",
      cameraPosition: this.camera.position.clone(),
      cameraQuaternion: this.camera.quaternion.clone(),
      cameraUp: this.camera.up.clone(),
      controlsTarget: this.controls.target.clone(),
      parts: [...this.partObjects.entries()].map(([partId, object]) => ({
        partId,
        visible: object.visible,
        position: object.position.clone()
      }))
    };
  }

  restoreDisplayState(state) {
    if (!state) return;
    this.reviewOpacity.clear();
    for (const entry of state.parts || []) {
      const object = this.partObjects.get(entry.partId);
      if (!object) continue;
      object.visible = entry.visible;
      object.position.copy(entry.position);
    }
    this.selectedPartId = state.selectedPartId || null;
    this.ghostMode = Boolean(state.ghostMode);
    this.wireframe = Boolean(state.wireframe);
    this.viewPreset = state.viewPreset || "free";
    this.switchCamera(state.cameraType === "ortho" ? this.orthoCamera : this.perspectiveCamera);
    this.camera.position.copy(state.cameraPosition);
    this.camera.quaternion.copy(state.cameraQuaternion);
    this.camera.up.copy(state.cameraUp);
    this.controls.target.copy(state.controlsTarget);
    this.controls.update();
    this.applyAppearance();
    this.render();
  }

  setReviewTransparency(partIds = [], opacity = 0.1) {
    this.reviewOpacity.clear();
    const safeOpacity = Math.max(0.03, Math.min(0.45, Number(opacity) || 0.1));
    for (const partId of partIds) if (this.partObjects.has(String(partId))) this.reviewOpacity.set(String(partId), safeOpacity);
    this.applyAppearance();
    this.render();
  }

  setReviewVisibility(partIds = [], visible = true) {
    for (const partId of partIds) {
      const object = this.partObjects.get(String(partId));
      if (object) object.visible = Boolean(visible);
    }
    this.render();
  }

  setExplodedReview(spacingFactor = 0.2) {
    if (!this.root || this.partObjects.size < 2) return false;
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    const span = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1);
    const entries = [...this.partObjects.entries()];
    for (const [index, [, object]] of entries.entries()) {
      const objectCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      const direction = objectCenter.sub(center);
      if (direction.lengthSq() < 1e-8) {
        const angle = (index / entries.length) * Math.PI * 2;
        direction.set(Math.cos(angle), Math.sin(angle), index % 2 ? 0.35 : -0.35);
      }
      direction.normalize();
      const stagger = 0.65 + index / Math.max(entries.length - 1, 1) * 0.7;
      object.position.add(direction.multiplyScalar(span * spacingFactor * stagger));
    }
    this.reviewOpacity.clear();
    this.showAll();
    this.fitToObject(this.root, 1.15);
    this.render();
    return true;
  }

  setGhostMode(enabled) {
    this.ghostMode = Boolean(enabled);
    this.applyAppearance();
    this.render();
  }

  setWireframe(enabled) {
    this.wireframe = Boolean(enabled);
    if (this.root) this.root.traverse((object) => {
      if (object.isMesh) object.material.wireframe = this.wireframe;
      if (object.name === "__cad_edges__") object.visible = !this.wireframe;
    });
    this.render();
  }

  applyAppearance() {
    if (!this.root) return;
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      const partId = object.userData.partId;
      const selected = partId && partId === this.selectedPartId;
      const original = object.userData.originalMaterial;
      if (original) {
        object.material.color.copy(original.color);
        object.material.emissive.setHex(0x000000);
        object.material.opacity = 1;
        object.material.transparent = false;
        object.material.depthWrite = true;
      }
      if (selected) {
        object.material.emissive.setHex(0x174f91);
        object.material.emissiveIntensity = 0.85;
      } else if (this.ghostMode && this.selectedPartId) {
        object.material.transparent = true;
        object.material.opacity = 0.16;
        object.material.depthWrite = false;
      }
      const reviewOpacity = this.reviewOpacity.get(partId);
      if (Number.isFinite(reviewOpacity)) {
        object.material.transparent = true;
        object.material.opacity = reviewOpacity;
        object.material.depthWrite = false;
      }
      object.material.wireframe = this.wireframe;
    });
  }

  setViewPreset(name) {
    if (!this.root) return;
    this.viewPreset = name;
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.75, 1);
    const directions = {
      front: new THREE.Vector3(0, -1, 0),
      top: new THREE.Vector3(0, 0, 1),
      side: new THREE.Vector3(1, 0, 0),
      free: new THREE.Vector3(1, -1, 0.72).normalize()
    };
    const useOrtho = name !== "free";
    this.switchCamera(useOrtho ? this.orthoCamera : this.perspectiveCamera);
    this.camera.position.copy(center).add(directions[name] || directions.free).multiplyScalar(radius).add(center.clone().multiplyScalar(1 - radius));
    this.camera.up.set(0, 0, 1);
    if (name === "top") this.camera.up.set(0, 1, 0);
    this.controls.target.copy(center);
    if (useOrtho) this.configureOrtho(box);
    this.camera.lookAt(center);
    this.controls.update();
    this.render();
  }

  switchCamera(camera) {
    const target = this.controls.target.clone();
    const position = this.camera.position.clone();
    this.controls.dispose();
    this.camera = camera;
    this.camera.position.copy(position);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(target);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => this.render());
  }

  configureOrtho(box) {
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1) * 0.65;
    const aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
    this.orthoCamera.left = -span * aspect;
    this.orthoCamera.right = span * aspect;
    this.orthoCamera.top = span;
    this.orthoCamera.bottom = -span;
    this.orthoCamera.updateProjectionMatrix();
  }

  fitToObject(object, offset = 1.35) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(size.length() * offset, 1);
    this.switchCamera(this.perspectiveCamera);
    this.camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.72).normalize().multiplyScalar(distance));
    this.camera.near = Math.max(distance / 1000, 0.01);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.grid.position.z = box.min.z;
    this.grid.scale.setScalar(Math.max(size.length() / 600, 0.05));
  }

  resize() {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const pixelWidth = Math.floor(width * Math.min(window.devicePixelRatio || 1, 2));
    const pixelHeight = Math.floor(height * Math.min(window.devicePixelRatio || 1, 2));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) this.renderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    if (this.root && this.camera === this.orthoCamera) this.configureOrtho(new THREE.Box3().setFromObject(this.root));
    this.render();
  }

  stats() {
    let triangles = 0;
    let meshes = 0;
    if (this.root) this.root.traverse((object) => {
      if (!object.isMesh) return;
      meshes += 1;
      const position = object.geometry.getAttribute("position");
      triangles += object.geometry.index ? object.geometry.index.count / 3 : (position?.count || 0) / 3;
    });
    return { triangles: Math.round(triangles), meshes, parts: this.partObjects.size, selectedPartId: this.selectedPartId };
  }

  emitStats(label = null, format = null) {
    const stats = this.stats();
    this.onStats({ ...stats, label, format });
  }

  capture() {
    this.render();
    return this.canvas.toDataURL("image/png");
  }

  cancelPendingLoad() {
    this.loadSequence += 1;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  animate() {
    this.animationFrame = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.render();
  }

  clearModel() {
    if (!this.root) return;
    this.scene.remove(this.root);
    this.disposeObject(this.root);
    this.root = null;
    this.partObjects.clear();
    this.meshToPart.clear();
    this.reviewOpacity.clear();
    this.selectedPartId = null;
  }

  disposeObject(root) {
    root?.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material?.dispose?.();
    });
  }

  dispose() {
    this.cancelPendingLoad();
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener("click", this.handlePointer);
    this.controls.dispose();
    this.clearModel();
    this.renderer.dispose();
  }
}
