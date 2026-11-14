/**
 * 3Dビュー。メッシュ生成、シェーダ、カメラ、ピック、書き出し用のオフスクリーン描画。
 * 単位は元画像の 1 ピクセル = 1、画像の中心が原点。
 */
import * as THREE from 'three';
import { LAYER_COLORS, meshSegments, type CameraState, type Document, type Layer, type OrthoView, type Vec3 } from '../model/project';
import type { Rect } from '../model/weightmap';
import { vertexShader, fragmentShader, MAX_LAYERS } from './shaders';

export interface ViewOptions {
  /** overlayAll: 重ね表示を全レイヤーにする(overlay が入のときだけ意味を持つ) */
  overlay: boolean; overlayAll: boolean; grid: boolean;
  /** 画像を薄くして塗りを見やすくする */
  fade: boolean;
  /** ポップ(持ち上げと揺れ)を一時的に消して平らに表示する */
  flat: boolean;
  /** 3面図(正面・右・下・自由角度)を横に並べる。並べ方は UI が setLayout で渡す */
  multi: boolean;
}

/** キャンバス左上からの矩形(CSS ピクセル) */
export interface ViewRect { x: number; y: number; w: number; h: number }
export type SubViewKind = 'front' | 'right' | 'bottom' | 'free';

/** 3面図の各向き(画像のローカル座標)。正面図に対して第三角法の位置関係になるよう上方向を決める */
const ORTHO_DIRS: Record<Exclude<SubViewKind, 'free'>, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
  front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  bottom: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
};

/** 3面図の正投影の図の拡大率の範囲 */
export const ORTHO_ZOOM = { min: 0.5, max: 20 };
const ORTHO_NONE: OrthoView = { zoom: 1, pan: { x: 0, y: 0, z: 0 } };

export interface PickResult {
  x: number; y: number; // ドキュメントのローカル座標(ピクセル)
  u: number; v: number; // 0〜1、v は下が 0
  inside: boolean;
}

const IDENTITY = new THREE.Matrix4();

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private material: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;
  private mapTex: THREE.Texture | null = null;
  private weightTex: THREE.DataArrayTexture | null = null;
  private weightSize = { w: 1, h: 1 };
  private imageSize = { w: 1, h: 1 };
  private exportTarget: THREE.WebGLRenderTarget | null = null;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();
  private pickInv = new THREE.Matrix4();
  private pickRay = new THREE.Ray();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private gridN = new THREE.Vector2(1, 1);
  /** 主ビューの矩形。null ならキャンバス全体 */
  private mainRect: ViewRect | null = null;
  private subViews: { kind: SubViewKind; rect: ViewRect }[] = [];
  private orthoCam = new THREE.OrthographicCamera();
  private freeCam = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  /** ドキュメントの位置(setTransform)と、そこからの画像全体のずれ(揺らし方「ピストン」、画像のローカル座標のピクセル) */
  private restPos = new THREE.Vector3();
  private baseOffset = new THREE.Vector3();
  /** ずれを除いた、画像の置き場所の行列。3面図の正投影の図はこれに合わせるので、画像全体の動きも図の中に見える */
  private restMatrix = new THREE.Matrix4();
  /** 画像全体がいちばん上がったときのずれ(元画像のピクセル)。3面図の図に、上がった画像も収まるようにする */
  private baseReach = 0;
  private tmp = new THREE.Vector3();
  /**
   * 記録の再生中に画像を動かす行列(setRig)。画像はこの中に置く。再生していないときは単位行列。
   * 主ビューは自由に動かせる視点から見るので、画像のほうが動いて見える。3面図の図は画像と一緒に動かし、今までどおり画像に付いた図にする
   */
  private rig = new THREE.Group();
  private rigOn = false;
  private rigCamA = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  private rigCamB = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  private rigInv = new THREE.Matrix4();
  private rigRest = new THREE.Matrix4();
  /** キーフレームのゴースト(主ビューだけに出す、平らな半透明の画像)。setGhosts で置く */
  private ghosts = new THREE.Group();
  private ghostGeo: THREE.PlaneGeometry | null = null;
  private ghostMats: THREE.MeshBasicMaterial[] = [];
  vertexCount = 0;
  /** ウェイトを部分転送・全面転送した回数(部分転送が効いているかの確認用) */
  partialUploads = 0;
  fullUploads = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // ライティング無しで画像をそのまま出すので、色空間の変換は挟まない
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.uniforms = {
      uMap: { value: null }, uW: { value: null }, uLayerCount: { value: 0 },
      uPop: { value: new Array(MAX_LAYERS).fill(0) },
      uBlend: { value: new Array(MAX_LAYERS).fill(0) },
      uSwing: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector3()) },
      uSpread: { value: new Array(MAX_LAYERS).fill(0) },
      uCenter: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector2()) },
      uShow: { value: new Array(MAX_LAYERS).fill(0) }, uColor: { value: LAYER_COLORS.map(rgbVector) }, uOverlay: { value: 1 }, uGrid: { value: 0 },
      uBrushOn: { value: 0 }, uBrush: { value: new THREE.Vector3() }, uOpacity: { value: 1 },
      uFade: { value: 0 }, uFlat: { value: 0 },
      uGridN: { value: this.gridN },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, side: THREE.DoubleSide, depthWrite: true,
    });
    this.rig.matrixAutoUpdate = false;
    this.scene.add(this.rig);
    this.ghosts.visible = false;
    this.scene.add(this.ghosts);
  }

  get maxTextureSize(): number { return this.renderer.capabilities.maxTextureSize; }
  get hasDocument(): boolean { return !!this.mesh; }

  /**
   * 画像・ウェイト・メッシュのために持っているメモリの見積もり(バイト)。
   * 画像のテクスチャはミップマップの分で 4/3 倍。ウェイトは GPU と CPU 側の写しの2つ分。画面の描画先は数えない
   */
  get gpuBytes(): number {
    const img = this.mapTex?.image as { width?: number; height?: number } | undefined;
    const map = img?.width && img.height ? img.width * img.height * 4 * 4 / 3 : 0;
    const weights = this.weightTex ? this.weightSize.w * this.weightSize.h * MAX_LAYERS * 2 : 0;
    // 頂点ごとに位置・法線・UV(8 個の float)、マスごとに三角形2つの添字(6 個、4 バイト)
    const mesh = this.mesh ? this.vertexCount * 8 * 4 + this.gridN.x * this.gridN.y * 6 * 4 : 0;
    return Math.round(map + weights + mesh);
  }

  /* ---------- ドキュメント ---------- */

  /** 画像を差し替える。source は縮小済みでもよい(メッシュは元画像のピクセル単位)。 */
  setImage(source: TexImageSource & { width: number; height: number }, imageW: number, imageH: number): void {
    this.mapTex?.dispose();
    const tex = new THREE.Texture(source as THREE.Texture['image']);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    this.mapTex = tex;
    this.uniforms.uMap.value = tex;
    this.imageSize = { w: imageW, h: imageH };
    for (const m of this.ghostMats) { m.map = tex; m.needsUpdate = true; }
    // 板は新しい画像の大きさで作り直す。次の setGhosts までは出さない
    this.ghosts.visible = false;
    this.ghostGeo?.dispose(); this.ghostGeo = null;
  }

  rebuildMesh(density: number): void {
    const { w, h } = this.imageSize;
    const { nx, ny } = meshSegments(w, h, density);
    if (this.mesh) { this.rig.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, nx, ny), this.material);
    this.mesh.frustumCulled = false;
    this.rig.add(this.mesh);
    this.gridN.set(nx, ny);
    this.vertexCount = (nx + 1) * (ny + 1);
  }

  setTransform(doc: Pick<Document, 'position' | 'rotation' | 'scale' | 'opacity'>): void {
    if (!this.mesh) return;
    this.restPos.set(doc.position.x, doc.position.y, doc.position.z);
    this.mesh.rotation.set(doc.rotation.x, doc.rotation.y, doc.rotation.z);
    this.mesh.scale.setScalar(doc.scale);
    this.restMatrix.compose(this.restPos, this.mesh.quaternion, this.mesh.scale);
    this.place(this.uniforms.uFlat.value === 0);
    this.uniforms.uOpacity.value = doc.opacity;
  }

  /** 画像全体のずれ(画像のローカル座標、元画像のピクセル)。描画の前に毎回入れる */
  setBaseOffset(v: Vec3): void { this.baseOffset.set(v.x, v.y, v.z); }
  setBaseReach(px: number): void { this.baseReach = Math.max(0, px); }

  /** メッシュをドキュメントの位置へ置く。offset が true なら画像全体のずれも足す(ずれは画像と一緒に回転・拡大する) */
  private place(offset: boolean): void {
    const m = this.mesh; if (!m) return;
    m.position.copy(this.restPos);
    if (offset) m.position.add(this.tmp.copy(this.baseOffset).applyQuaternion(m.quaternion).multiplyScalar(m.scale.x));
    this.rig.updateMatrixWorld(true);
  }

  /**
   * 視点が from から to へ動いて見えるのと同じだけ画像を動かす行列(ワールド座標)。setRig と同じ計算で、縦横比は主ビューのもの。
   * キーフレームを「from の視点のカメラを止めたまま、画像のほうを動かした」形で描くのに使う
   */
  rigMatrix(from: CameraState, to: CameraState, out = new THREE.Matrix4()): THREE.Matrix4 {
    this.applyCamera(from, this.camera.aspect, this.rigCamA);
    this.applyCamera(to, this.camera.aspect, this.rigCamB);
    return out.multiplyMatrices(this.rigCamA.matrixWorld, this.rigInv.copy(this.rigCamB.matrixWorld).invert());
  }

  /**
   * 画像を rig の行列で動かしたときの、画像の四隅(左上・右上・右下・左下)と中心(ワールド座標)。
   * 持ち上げる前の平面で、揺れやピストンでは動かない
   */
  placedOutline(rig: THREE.Matrix4): { corners: Vec3[]; center: Vec3 } {
    const { w, h } = this.imageSize, m = this.rigRest.multiplyMatrices(rig, this.restMatrix);
    const at = (x: number, y: number): Vec3 => { const v = this.projV.set(x, y, 0).applyMatrix4(m); return { x: v.x, y: v.y, z: v.z }; };
    return { corners: [at(-w / 2, h / 2), at(w / 2, h / 2), at(w / 2, -h / 2), at(-w / 2, -h / 2)], center: at(0, 0) };
  }

  /**
   * キーフレームのゴーストを置く。各行列で動かした画像を、平らな半透明で主ビューにだけ重ねる(3面図・書き出しには出さない)。
   * strong の番号は濃くする。null か空で消す。動かさない(単位行列の)ものは画像そのものと重なるので出さない
   */
  setGhosts(rigs: readonly THREE.Matrix4[] | null, strong = -1): void {
    const g = this.ghosts;
    if (!rigs?.length || !this.mapTex) { g.visible = false; return; }
    const { w, h } = this.imageSize;
    this.ghostGeo ??= new THREE.PlaneGeometry(w, h);
    while (g.children.length < rigs.length) {
      const mat = new THREE.MeshBasicMaterial({ map: this.mapTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.ghostMats.push(mat);
      const mesh = new THREE.Mesh(this.ghostGeo, mat);
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      g.add(mesh);
    }
    g.children.forEach((o, i) => {
      const mesh = o as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      mesh.visible = i < rigs.length && !rigs[i].equals(IDENTITY);
      if (!mesh.visible) return;
      mesh.geometry = this.ghostGeo!;
      mesh.matrix.multiplyMatrices(rigs[i], this.restMatrix);
      mesh.material.opacity = i === strong ? 0.55 : 0.28;
      // 後のキーほど上に重ねる
      mesh.renderOrder = 1 + i;
    });
    g.visible = true;
    g.updateMatrixWorld(true);
  }

  /**
   * 記録の再生中に、視点の代わりに画像を動かす。視点が from から to へ動いて見えるのと同じだけ画像を動かす
   * (画像から見た視点が to になる)。見る視点が from のままなら、画面は視点を to にしたときとまったく同じ。
   * 縦横比は主ビューのもの。null で画像を元の置き場所へ戻す
   */
  setRig(from: CameraState | null, to?: CameraState | null): void {
    const g = this.rig;
    if (!from || !to) {
      if (!this.rigOn) return;
      this.rigOn = false;
      g.matrix.identity();
    } else {
      this.applyCamera(from, this.camera.aspect, this.rigCamA);
      this.applyCamera(to, this.camera.aspect, this.rigCamB);
      g.matrix.multiplyMatrices(this.rigCamA.matrixWorld, this.rigInv.copy(this.rigCamB.matrixWorld).invert());
      this.rigOn = true;
    }
    g.matrixWorldNeedsUpdate = true;
    g.updateMatrixWorld(true);
  }

  /** ウェイトのテクスチャ配列を作り直して全レイヤーを転送する。 */
  setLayers(layers: readonly Layer[]): void {
    const w = layers[0]?.weights.width ?? 1, h = layers[0]?.weights.height ?? 1;
    if (!this.weightTex || this.weightSize.w !== w || this.weightSize.h !== h) {
      this.weightTex?.dispose();
      const tex = new THREE.DataArrayTexture(new Uint8Array(w * h * MAX_LAYERS), w, h, MAX_LAYERS);
      tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false; tex.unpackAlignment = 1;
      this.weightTex = tex; this.weightSize = { w, h };
      this.uniforms.uW.value = tex;
    }
    const data = this.weightTex.image.data as Uint8Array;
    data.fill(0);
    layers.forEach((l, i) => data.set(l.weights.data, i * w * h));
    this.weightTex.needsUpdate = true;
    this.fullUploads++;
    this.uniforms.uLayerCount.value = layers.length;
    layers.forEach((l, i) => this.setLayerParams(i, l));
  }

  setLayerParams(index: number, layer: Pick<Layer, 'pop' | 'visible' | 'blend'>): void {
    (this.uniforms.uPop.value as number[])[index] = layer.visible ? layer.pop : 0;
    // 隠したレイヤーはずれが 0 なので、最大のまま比べると下の沈み込みを平らにしてしまう。加算(何も足さない)として扱う
    (this.uniforms.uBlend.value as number[])[index] = layer.visible && layer.blend === 'max' ? 1 : 0;
  }

  setSwing(index: number, s: Vec3, visible: boolean): void {
    const v = (this.uniforms.uSwing.value as THREE.Vector3[])[index];
    if (visible) v.set(s.x, s.y, s.z); else v.set(0, 0, 0);
  }

  /**
   * 塗った範囲の広がり(ためて膨らむ2 など、physics/motion.ts の SPREAD_MOTIONS)。center はそのレイヤーのウェイトの重心(画像のローカル座標、元画像のピクセル)、
   * r は中心からの距離に対する割合。広がらないレイヤーは r = 0
   */
  setSpread(index: number, center: { x: number; y: number }, r: number, visible: boolean): void {
    (this.uniforms.uSpread.value as number[])[index] = visible ? r : 0;
    (this.uniforms.uCenter.value as THREE.Vector2[])[index].set(center.x, center.y);
  }

  /** 塗った矩形だけをテクスチャへ転送する。まだGPUに無いときは全面転送に切り替える。 */
  uploadWeights(index: number, layer: Layer, rect: Rect): void {
    const tex = this.weightTex; if (!tex) return;
    const { w, h } = this.weightSize, data = tex.image.data as Uint8Array, base = index * w * h;
    const src = layer.weights.data;
    for (let y = rect.y; y < rect.y + rect.h; y++) data.set(src.subarray(y * w + rect.x, y * w + rect.x + rect.w), base + y * w + rect.x);
    const props = this.renderer.properties.get(tex) as { __webglTexture?: WebGLTexture; __version?: number };
    const gl = this.renderer.getContext();
    if (this.partialBroken || !props.__webglTexture || props.__version !== tex.version || !(gl instanceof WebGL2RenderingContext)) {
      tex.needsUpdate = true; this.fullUploads++;
      return;
    }
    // 矩形を詰めた配列にコピーして送る。ROW_LENGTH / SKIP_* を使うとブラウザによって
    // "invalid unpack params combination" で拒否されるため、unpack の設定はすべて既定値にする
    const sub = this.subBuffer.length >= rect.w * rect.h ? this.subBuffer.subarray(0, rect.w * rect.h) : (this.subBuffer = new Uint8Array(rect.w * rect.h));
    for (let y = 0; y < rect.h; y++) sub.set(src.subarray((rect.y + y) * w + rect.x, (rect.y + y) * w + rect.x + rect.w), y * rect.w);
    this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, rect.x, rect.y, index, rect.w, rect.h, 1, gl.RED, gl.UNSIGNED_BYTE, sub);
    // 最初の1回だけ成否を確かめ、失敗する環境では以後すべて全面転送にする
    if (!this.partialChecked) {
      this.partialChecked = true;
      if (gl.getError() !== gl.NO_ERROR) {
        console.warn('PukuPop: 部分転送が使えないため、ウェイトは全面転送に切り替えます');
        this.partialBroken = true;
        tex.needsUpdate = true; this.fullUploads++;
        return;
      }
    }
    this.partialUploads++;
  }

  private subBuffer = new Uint8Array(0);
  private partialChecked = false;
  private partialBroken = false;

  /* ---------- 表示 ---------- */

  /** show: レイヤーごとの重ね表示の濃さ(0 で重ねない。一覧の下から順) */
  setView(o: ViewOptions, show: readonly number[]): void {
    this.uniforms.uOverlay.value = o.overlay ? 1 : 0;
    this.uniforms.uGrid.value = o.grid ? 1 : 0;
    this.uniforms.uFade.value = o.fade ? 1 : 0;
    this.uniforms.uFlat.value = o.flat ? 1 : 0;
    const s = this.uniforms.uShow.value as number[];
    for (let i = 0; i < MAX_LAYERS; i++) s[i] = show[i] ?? 0;
  }

  setBrush(p: { x: number; y: number } | null, radius: number): void {
    this.uniforms.uBrushOn.value = p ? 1 : 0;
    if (p) (this.uniforms.uBrush.value as THREE.Vector3).set(p.x, p.y, radius);
  }

  setBackground(color: string | null): void {
    // 出力で色空間を変換しないので、指定色も変換せずそのまま使う
    if (color) this.renderer.setClearColor(new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace), 1);
    else this.renderer.setClearColor(0x000000, 0);
  }

  /* ---------- カメラ ---------- */

  /** 画角を変えても正面から見た画像の大きさが変わらないよう、距離を画角から決める。 */
  cameraDistance(cam: CameraState, aspect = this.camera.aspect): number {
    const { w, h } = this.imageSize;
    return ((Math.max(h, w / aspect) * 0.62) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * cam.zoom;
  }

  applyCamera(cam: CameraState, aspect = this.camera.aspect, c = this.camera): void {
    const d = this.cameraDistance(cam, aspect), cp = Math.cos(cam.pitch);
    c.fov = cam.fov; c.aspect = aspect;
    c.near = Math.max(0.1, d * 0.01); c.far = d * 100;
    c.position.set(cam.target.x + d * Math.sin(cam.yaw) * cp, cam.target.y + d * Math.sin(cam.pitch), cam.target.z + d * Math.cos(cam.yaw) * cp);
    c.lookAt(cam.target.x, cam.target.y, cam.target.z);
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }

  /** 画面上の 1px がカメラ注視点の距離で何単位にあたるか */
  pixelToWorld(cam: CameraState): number {
    return (2 * this.cameraDistance(cam) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, this.main().h);
  }

  /** 画面の右・上方向(ワールド)を返す */
  screenAxes(): { right: Vec3; up: Vec3 } {
    const e = this.camera.matrixWorld.elements;
    return { right: { x: e[0], y: e[1], z: e[2] }, up: { x: e[4], y: e[5], z: e[6] } };
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const m = this.main();
    this.camera.aspect = m.w / Math.max(1, m.h);
  }

  /** 主ビューと横に並べる図の矩形を決める。subs を空にすると主ビューだけに戻る */
  setLayout(main: ViewRect | null, subs: { kind: SubViewKind; rect: ViewRect }[]): void {
    this.mainRect = main;
    this.subViews = subs;
    const m = this.main();
    this.camera.aspect = m.w / Math.max(1, m.h);
  }

  /** ポインタが主ビューの中にあるか(3面図を出しているときは、横の図の上を除く) */
  inMainView(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect(), m = this.main(), x = clientX - r.left - m.x, y = clientY - r.top - m.y;
    return x >= 0 && y >= 0 && x <= m.w && y <= m.h;
  }

  private main(): ViewRect {
    return this.mainRect ?? { x: 0, y: 0, w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  /** ポップの奥行きの範囲(画像のローカル z)。ウェイトは 0〜1、ポップ量は 0 以上なので、0 からポップ量の合計までに収まる */
  private depthRange(): { min: number; max: number } {
    const pops = this.uniforms.uPop.value as number[], n = this.uniforms.uLayerCount.value as number;
    const k = 1 - (this.uniforms.uFlat.value as number);
    let max = 0;
    for (let i = 0; i < n; i++) max += Math.max(0, pops[i]) * k;
    return { min: 0, max };
  }

  /**
   * 3面図のカメラ。3つの図は同じ縮尺にそろえ、ポップの膨らみも含めて収まる大きさにする。
   * 拡大率と中心のずれ(view)も3つで共有するので、正面と右・下の図で位置の対応が崩れない
   */
  private orthoCamera(kind: Exclude<SubViewKind, 'free'>, rect: ViewRect, scale: number, view: OrthoView): THREE.OrthographicCamera {
    const c = this.orthoCam, m = this.rigRest.multiplyMatrices(this.rig.matrix, this.restMatrix), { min, max } = this.depthRange();
    const { dir, up } = ORTHO_DIRS[kind], p = view.pan;
    const center = new THREE.Vector3(p.x, p.y, (min + max) / 2 + p.z).applyMatrix4(m);
    const d = new THREE.Vector3().copy(dir).transformDirection(m);
    const reach = (Math.max(this.imageSize.w, this.imageSize.h) + (max - min)) * 4 * this.mesh!.scale.x;
    c.position.copy(center).addScaledVector(d, reach);
    c.up.copy(up).transformDirection(m);
    c.lookAt(center);
    const hw = (rect.w * scale) / 2 / view.zoom, hh = (rect.h * scale) / 2 / view.zoom;
    c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh;
    c.near = 0.1; c.far = reach * 2;
    c.updateProjectionMatrix(); c.updateMatrixWorld();
    return c;
  }

  /** 1px あたりのワールド長さ。3つの図すべてに中身が収まる値をとる */
  private orthoScale(): number {
    const { w, h } = this.imageSize, { min, max } = this.depthRange();
    const depth = Math.max(max - min, Math.max(w, h) * 0.02);
    // 図の中心は画像の元の位置なので、上がった分は上下の両側に足す(ピストン)
    const hh = h + 2 * this.baseReach;
    const ext: Record<string, [number, number]> = { front: [w, hh], right: [depth, hh], bottom: [w, depth] };
    let k = 0;
    for (const v of this.subViews) {
      const e = ext[v.kind]; if (!e) continue;
      k = Math.max(k, e[0] / Math.max(1, v.rect.w), e[1] / Math.max(1, v.rect.h));
    }
    return k * 1.15 * (this.mesh?.scale.x ?? 1);
  }

  /** 3面図の正投影の図の、画面の右・上方向(画像のローカル座標)。カメラの x 軸は up × dir */
  private orthoAxes(kind: Exclude<SubViewKind, 'free'>): { right: THREE.Vector3; up: THREE.Vector3 } {
    const { dir, up } = ORTHO_DIRS[kind];
    return { right: new THREE.Vector3().crossVectors(up, dir), up: up.clone() };
  }

  /** 3面図の正投影の図で、画面の 1px が画像のローカル座標で何単位か(拡大率込み) */
  private orthoUnitPerPixel(view: OrthoView): number {
    return this.orthoScale() / (this.mesh?.scale.x ?? 1) / view.zoom;
  }

  /** 中心のずれは、画像と膨らみが図の外へ遠く離れない範囲に収める(軸ごとに、その向きの大きさ + 余白) */
  private clampOrthoPan(view: OrthoView): void {
    const { min, max } = this.depthRange(), { w, h } = this.imageSize, margin = Math.max(w, h) * 0.25;
    const p = view.pan, c = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
    p.x = c(p.x, w / 2 + margin); p.y = c(p.y, h / 2 + this.baseReach + margin); p.z = c(p.z, Math.max(Math.abs(min), Math.abs(max)) + margin);
  }

  /** 3面図の正投影の図を、画面上で (dx, dy) px ドラッグしたぶん平行移動する(画像がポインタに付いてくる向き) */
  panOrtho(view: OrthoView, kind: Exclude<SubViewKind, 'free'>, dx: number, dy: number): void {
    const k = this.orthoUnitPerPixel(view), { right, up } = this.orthoAxes(kind);
    const d = right.multiplyScalar(-dx * k).addScaledVector(up, dy * k);
    view.pan.x += d.x; view.pan.y += d.y; view.pan.z += d.z;
    this.clampOrthoPan(view);
  }

  /**
   * 3面図の正投影の図の拡大率を factor 倍にする。(cx, cy) は図の中心からのポインタの位置(px、下が正)で、
   * そこに映っている点が動かないよう中心をずらす
   */
  zoomOrtho(view: OrthoView, kind: Exclude<SubViewKind, 'free'>, factor: number, cx: number, cy: number): void {
    const k0 = this.orthoUnitPerPixel(view);
    const zoom = Math.max(ORTHO_ZOOM.min, Math.min(ORTHO_ZOOM.max, view.zoom * factor));
    const k1 = k0 * view.zoom / zoom, { right, up } = this.orthoAxes(kind);
    const d = right.multiplyScalar(cx * (k0 - k1)).addScaledVector(up, -cy * (k0 - k1));
    view.zoom = zoom;
    view.pan.x += d.x; view.pan.y += d.y; view.pan.z += d.z;
    this.clampOrthoPan(view);
  }

  /**
   * 3面図の自由角度の図を、画面上で (dx, dy) px ドラッグしたぶん平行移動する(画像がポインタに付いてくる向き)。
   * 動かすのは cam の注視点だけで、主ビューの視点や揺れの計算には関わらない
   */
  panFree(cam: CameraState, dx: number, dy: number): void {
    const v = this.subViews.find(s => s.kind === 'free');
    if (!v) return;
    const aspect = v.rect.w / Math.max(1, v.rect.h);
    this.applyCamera(cam, aspect, this.freeCam);
    const k = (2 * this.cameraDistance(cam, aspect) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, v.rect.h);
    const e = this.freeCam.matrixWorld.elements;
    cam.target.x += -dx * k * e[0] + dy * k * e[4];
    cam.target.y += -dx * k * e[1] + dy * k * e[5];
    cam.target.z += -dx * k * e[2] + dy * k * e[6];
  }

  /** 主ビューの矩形(キャンバス左上からの CSS ピクセル) */
  mainView(): ViewRect { return { ...this.main() }; }

  private projV = new THREE.Vector3();

  /** ワールドの点を今の主ビューの画面(主ビューの左上からの CSS ピクセル)へ。直前の render の視点を使う。カメラの後ろなら null */
  toMainScreen(p: Vec3): { x: number; y: number } | null {
    const c = this.camera, m = this.main(), v = this.projV.set(p.x, p.y, p.z);
    this.tmp.copy(v).applyMatrix4(c.matrixWorldInverse);
    if (this.tmp.z > -c.near) return null;
    v.project(c);
    const x = (v.x + 1) / 2 * m.w, y = (1 - v.y) / 2 * m.h;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  /** 画像のローカル座標(元画像のピクセル、中心が原点、y は上)の、持ち上げる前の平面の点を、主ビューの画面へ。直前の render の置き方と視点を使う */
  imageToMainScreen(x: number, y: number): { x: number; y: number } | null {
    if (!this.mesh) return null;
    const v = this.tmp.set(x, y, 0).applyMatrix4(this.mesh.matrixWorld);
    return this.toMainScreen({ x: v.x, y: v.y, z: v.z });
  }

  /** ポインタからのレイと「持ち上げる前の平面」の交点 */
  pick(clientX: number, clientY: number): PickResult | null {
    if (!this.mesh) return null;
    const r = this.canvas.getBoundingClientRect(), m = this.main();
    this.ndc.set(((clientX - r.left - m.x) / m.w) * 2 - 1, -(((clientY - r.top - m.y) / m.h) * 2 - 1));
    this.ray.setFromCamera(this.ndc, this.camera);
    // ポインタが動くたびに呼ばれるので、行列とレイは使い回す
    this.pickInv.copy(this.mesh.matrixWorld).invert();
    const local = this.pickRay.copy(this.ray.ray).applyMatrix4(this.pickInv);
    if (!local.intersectPlane(this.plane, this.hit)) return null;
    const { w, h } = this.imageSize, u = this.hit.x / w + 0.5, v = this.hit.y / h + 0.5;
    return { x: this.hit.x, y: this.hit.y, u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
  }

  /** free は 3面図の「自由角度」の視点、ortho は正面・右から・下からの図の拡大率と平行移動 */
  render(cam: CameraState, free?: CameraState, ortho: OrthoView = ORTHO_NONE): void {
    const r = this.renderer;
    // ポップ一時OFF のときは、画像全体のずれ(ピストン)も消して元の位置に置く
    this.place(this.uniforms.uFlat.value === 0);
    this.applyCamera(cam);
    r.setRenderTarget(null);
    if (!this.subViews.length || !this.mesh) {
      r.setScissorTest(false);
      r.setViewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
      r.render(this.scene, this.camera);
      return;
    }
    r.setScissorTest(true);
    this.drawIn(this.main(), this.camera);
    // 横の図は形を見るためのものなので、ブラシの円・ウェイトの重ね表示・画像を薄く・グリッド・ゴーストは効かせない
    const ghosts = this.ghosts.visible;
    this.ghosts.visible = false;
    const u = this.uniforms, brush = u.uBrushOn.value, overlay = u.uOverlay.value, fade = u.uFade.value, grid = u.uGrid.value;
    u.uBrushOn.value = 0; u.uOverlay.value = 0; u.uFade.value = 0; u.uGrid.value = 0;
    const scale = this.orthoScale();
    for (const v of this.subViews) {
      if (v.kind === 'free') {
        if (!free) continue;
        this.applyCamera(free, v.rect.w / Math.max(1, v.rect.h), this.freeCam);
        // 自由角度の図も画像と一緒に動かす(再生中も画像に付いた図のまま)
        if (this.rigOn) {
          const fc = this.freeCam;
          fc.matrix.multiplyMatrices(this.rig.matrix, fc.matrixWorld).decompose(fc.position, fc.quaternion, fc.scale);
          fc.updateMatrixWorld(true);
        }
        this.drawIn(v.rect, this.freeCam);
      } else {
        this.drawIn(v.rect, this.orthoCamera(v.kind, v.rect, scale, ortho));
      }
    }
    u.uBrushOn.value = brush; u.uOverlay.value = overlay; u.uFade.value = fade; u.uGrid.value = grid;
    this.ghosts.visible = ghosts;
    r.setScissorTest(false);
  }

  private drawIn(rc: ViewRect, cam: THREE.Camera): void {
    const y = this.canvas.clientHeight - rc.y - rc.h;
    this.renderer.setViewport(rc.x, y, rc.w, rc.h);
    this.renderer.setScissor(rc.x, y, rc.w, rc.h);
    this.renderer.render(this.scene, cam);
  }

  /* ---------- 書き出し ---------- */

  /**
   * 指定サイズでオフスクリーンに描き、上の行から並んだ RGBA(ストレートアルファ)を返す。
   * ウェイト重ね表示・グリッド・ブラシカーソル・画像を薄く・ポップ一時OFF は反映しない。
   */
  renderFrame(width: number, height: number, cam: CameraState, background: string | null, out?: Uint8ClampedArray): Uint8ClampedArray {
    if (!this.exportTarget || this.exportTarget.width !== width || this.exportTarget.height !== height) {
      this.exportTarget?.dispose();
      this.exportTarget = new THREE.WebGLRenderTarget(width, height, { samples: 4, depthBuffer: true });
    }
    const u = this.uniforms, viewOnly = [u.uOverlay, u.uGrid, u.uBrushOn, u.uFade, u.uFlat];
    const saved = viewOnly.map(x => x.value);
    for (const x of viewOnly) x.value = 0;
    const ghosts = this.ghosts.visible;
    this.ghosts.visible = false;
    // 書き出しは記録の視点そのもので撮るので、画像は元の置き場所に置く
    const rigSaved = this.rigOn ? this.rig.matrix.clone() : null;
    this.rig.matrix.identity(); this.rig.matrixWorldNeedsUpdate = true;
    this.place(true);
    const clear = new THREE.Color(), clearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(clear);
    this.setBackground(background);
    const aspect = this.camera.aspect;
    this.applyCamera(cam, width / height);
    this.renderer.setRenderTarget(this.exportTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const raw = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(this.exportTarget, 0, 0, width, height, raw);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, clearAlpha);
    this.camera.aspect = aspect;
    viewOnly.forEach((x, i) => { x.value = saved[i]; });
    if (rigSaved) { this.rig.matrix.copy(rigSaved); this.rig.matrixWorldNeedsUpdate = true; }
    this.ghosts.visible = ghosts;
    this.place(this.uniforms.uFlat.value === 0);

    // 下から上へ並んでいるので反転し、乗算済みの色をストレートアルファへ戻す
    const px = out && out.length === raw.length ? out : new Uint8ClampedArray(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const s = (height - 1 - y) * row, d = y * row;
      for (let i = 0; i < row; i += 4) {
        const a = raw[s + i + 3];
        if (a === 255 || a === 0) { px[d + i] = raw[s + i]; px[d + i + 1] = raw[s + i + 1]; px[d + i + 2] = raw[s + i + 2]; }
        else { const k = 255 / a; px[d + i] = raw[s + i] * k; px[d + i + 1] = raw[s + i + 1] * k; px[d + i + 2] = raw[s + i + 2] * k; }
        px[d + i + 3] = a;
      }
    }
    return px;
  }

  dispose(): void {
    this.mapTex?.dispose(); this.weightTex?.dispose(); this.exportTarget?.dispose();
    this.mesh?.geometry.dispose(); this.material.dispose(); this.renderer.dispose();
    this.ghostGeo?.dispose(); for (const m of this.ghostMats) m.dispose();
  }
}

/** '#rrggbb' を 0〜1 の vec3 にする(色空間の変換はしない。シェーダの中の色と同じ扱い) */
function rgbVector(hex: string): THREE.Vector3 {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
