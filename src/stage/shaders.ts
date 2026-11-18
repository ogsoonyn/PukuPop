/**
 * 頂点シェーダがウェイトマップ(テクスチャ配列)を読み、各レイヤーのずれ d_i を一覧の下から順に重ねて持ち上げる。
 *   d_i = w_i (p_i ẑ + s_i) + w_i r_i (x_xy - c_i)
 * r_i は塗った範囲の広がり(ためて膨らむ2 など、physics/motion.ts の SPREAD_MOTIONS)、c_i はそのレイヤーのウェイトの重心。広がりは画像の面内だけに効く。
 * 重ね方(uBlend): 0 = 加算(下までのずれ D に d_i を足す)、1 = 最大(D と d_i の高さ z を比べ、高い方のずれを使う)。
 * 最大は高さの差が小さい所で2つをなめらかに混ぜる。境目で揺れの向きが急に変わってメッシュが折れないようにするため。
 * 塗っていない所(w_i = 0)は下のずれをそのまま残す。
 * ウェイトマップは行 0 が画像の上端なので、v を反転して読む。
 */
export const MAX_LAYERS = 8;

/**
 * fx が true のときは、膨らんだ瞬間のエフェクト用(effectFragmentShader と組む)。同じ変形をしたあと、
 * レイヤー uFxLayer のウェイトの重心 uFxCenter のまわりで uFxScale 倍に広げ、そのウェイトの分だけ uFxLift 手前へ出す。
 * 揺れ(uSwing / uSpread)は、そのレイヤーだけエフェクトを出した瞬間の値に差し替えて渡す(Stage.setEffects)。
 */
const makeVertexShader = (fx: boolean) => /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uW;
  uniform int uLayerCount;
  uniform float uPop[${MAX_LAYERS}];
  uniform int uBlend[${MAX_LAYERS}];
  uniform vec3 uSwing[${MAX_LAYERS}];
  uniform float uSpread[${MAX_LAYERS}];
  uniform vec2 uCenter[${MAX_LAYERS}];
  uniform float uFlat;
  varying vec2 vUv;
  varying vec2 vP;
  ${fx ? 'uniform int uFxLayer; uniform vec2 uFxCenter; uniform float uFxScale, uFxLift; uniform vec2 uFxDir; varying float vFw, vSide;' : ''}
  void main() {
    vUv = uv;
    vP = position.xy;
    vec2 wuv = vec2(uv.x, 1.0 - uv.y);
    vec3 p = position;
    for (int i = 0; i < ${MAX_LAYERS}; i++) {
      if (i >= uLayerCount) break;
      float w = textureLod(uW, vec3(wuv, float(i)), 0.0).r;
      vec3 d = w * (vec3(0.0, 0.0, uPop[i]) + uSwing[i]);
      d.xy += w * uSpread[i] * (position.xy - uCenter[i]);
      if (uBlend[i] == 1) {
        vec3 below = p - position;
        float soft = max(0.08 * max(abs(d.z), abs(below.z)), 0.5);
        float t = smoothstep(-soft, soft, d.z - below.z) * smoothstep(0.0, 0.02, w);
        p = position + mix(below, d, t);
      } else {
        p += d;
      }
    }
    ${fx ? `
    float fw = textureLod(uW, vec3(wuv, float(uFxLayer)), 0.0).r;
    vFw = fw;
    // uFxDir が 0 でなければ、重心から見てその向きの側だけを広げる(揺れた向きの側だけがポワンと膨らむ)
    float dirOn = step(0.001, dot(uFxDir, uFxDir));
    vec2 rel = position.xy - uFxCenter;
    float side = dot(rel / max(length(rel), 1e-3), uFxDir);
    vSide = mix(1.0, smoothstep(-0.15, 0.6, side), dirOn);
    p.xy = uFxCenter + (p.xy - uFxCenter) * (1.0 + (uFxScale - 1.0) * vSide);
    p.z = p.z * uFxScale + fw * uFxLift;` : ''}
    // ポップ一時OFF: 持ち上げと揺れ(広がりも)を消して平らな画像に戻す
    p = mix(p, position, uFlat);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const vertexShader = makeVertexShader(false);
export const effectVertexShader = makeVertexShader(true);

/**
 * 膨らんだ瞬間のエフェクト。膨らんだ部分(ウェイト vFw)だけを切り抜いた画像の半透明のコピーと、
 * uFxRing が 1 ならその輪郭(ウェイトが 0.3 前後の帯)を波紋として描く。色は uTint へ uTintMix だけ寄せる
 */
export const effectFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity, uFxAlpha, uFxRing, uTintMix;
  uniform vec3 uTint;
  varying vec2 vUv;
  varying float vFw, vSide;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    float copyA = c.a * smoothstep(0.03, 0.45, vFw) * uFxAlpha * 0.85 * vSide;
    float ring = smoothstep(0.08, 0.3, vFw) - smoothstep(0.3, 0.6, vFw);
    float ringA = min(1.0, ring * uFxAlpha * 1.5) * uFxRing * vSide;
    float a = copyA + ringA * (1.0 - copyA);
    if (a < 0.004) discard;
    vec3 copyC = mix(c.rgb, uTint, uTintMix), ringC = mix(c.rgb, uTint, max(uTintMix, 0.6));
    gl_FragColor = vec4(mix(copyC, ringC, ringA / a), a * uOpacity);
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2D uMap;
  uniform sampler2DArray uW;
  uniform int uLayerCount;
  uniform float uShow[${MAX_LAYERS}];
  uniform vec3 uColor[${MAX_LAYERS}];
  uniform float uOverlay, uGrid, uBrushOn, uOpacity, uFade;
  uniform vec2 uGridN;
  uniform vec3 uBrush;
  varying vec2 vUv;
  varying vec2 vP;

  void main() {
    vec4 c = texture2D(uMap, vUv);
    c.a *= uOpacity;
    vec2 wuv = vec2(vUv.x, 1.0 - vUv.y);

    // 画像を薄く: 色を落として半透明にし、塗りの状況を見やすくする
    if (uFade > 0.5) {
      float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb, vec3(g), 0.7);
      c.a *= 0.25;
    }

    // ウェイトをレイヤーごとの色で、一覧の下から順に半透明で重ねる(画像を薄くしているときは濃く)。
    // uShow は重ねる濃さの倍率で、0 のレイヤーは重ねない(選択中だけ / 全レイヤーで選んだもの以外を薄く、は呼び出し側が決める)
    if (uOverlay > 0.5) {
      float k = uFade > 0.5 ? 0.9 : 0.5;
      for (int i = 0; i < ${MAX_LAYERS}; i++) {
        if (i >= uLayerCount) break;
        if (uShow[i] <= 0.0) continue;
        float a = texture(uW, vec3(wuv, float(i))).r * k * uShow[i];
        c.rgb = mix(c.rgb, uColor[i], clamp(a / max(max(c.a, a), 1e-4), 0.0, 1.0));
        c.a = max(c.a, a);
      }
    }

    // グリッド(メッシュの分割線)
    vec2 g = vUv * uGridN;
    vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
    float line = (1.0 - min(min(d.x, d.y), 1.0)) * uGrid;
    c.rgb = mix(c.rgb, vec3(0.1, 0.75, 1.0), line * 0.7);
    c.a = max(c.a, line * 0.7);

    // ブラシカーソル(持ち上げる前の平面上の円)
    float r = length(vP - uBrush.xy);
    float fw = fwidth(r);
    float ring = (1.0 - smoothstep(fw, fw * 2.5, abs(r - uBrush.z))) * uBrushOn;
    float ring2 = (1.0 - smoothstep(fw, fw * 2.5, abs(r - uBrush.z - fw * 2.0))) * uBrushOn;
    c.rgb = mix(c.rgb, vec3(0.0), ring2 * 0.6);
    c.rgb = mix(c.rgb, vec3(1.0), ring * 0.95);
    c.a = max(c.a, max(ring, ring2 * 0.6));

    if (c.a < 0.004) discard;
    gl_FragColor = c;
  }
`;
