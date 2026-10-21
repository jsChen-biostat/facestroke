/**
 * 四网络集成推理（与文献相同的框架）
 *
 * 文献：Wang YY, et al. Aging Cell 2024;23:e14196
 *   —— 集成四个网络（Xception + ResNet50 + VGG19 + EfficientNetB1）对**二维人脸图像**
 *      做识别，训练集交叉验证 AUC 0.91，独立数据集 AUC 0.82。
 *
 * 本模块实现的是**同一套流程**：
 *   人脸对齐裁剪 → 四个骨干各自推理 → sigmoid → 取平均 → 一个概率
 *
 * 与文献的差异（必须如实说明）
 *   骨架默认使用**可端上部署的替代骨干**（`light` 档）：MobileNetV3-Large、ResNet18、
 *   EfficientNet-B0、SqueezeNet。原因是文献那四个骨干合计 **763 MB**
 *   （其中 VGG19 一个就 558 MB），无法装进手机安装包。
 *   集成方式、输入尺寸、对齐方式、训练脚本均与文献一致，只有骨干可替换。
 *
 * ⚠️ 当前权重是**未训练**的占位权重（`ensemble.json` 中 `trained: false`）。
 *    它的唯一用途是把整条流程跑通；输出的数字**没有任何医学含义**。
 *    界面必须如实标注，不得呈现为风险判断。
 */

import * as ort from 'onnxruntime-web/wasm';
import { CONFIG } from './config.js';
import { prepareWasmPaths } from './cnn.js';

const INPUT = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const LEFT_EYE = 33;
const RIGHT_EYE = 263;
/** 裁剪边长 = 眼距 × margin；1.6 时双眼间距约 140px，与训练端一致。 */
const MARGIN = 1.6;

let manifestPromise = null;
let sessionsPromise = null;

function baseDir() {
  const dir = CONFIG.strokeEnsemble?.dir || 'models/ensemble';
  return new URL(`${dir}/`, document.baseURI).href;
}

/** 读取模型清单；不存在时返回 null（不抛异常，由调用方决定怎么显示）。 */
export function loadEnsembleManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(`${baseDir()}ensemble.json`, { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`ensemble.json HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        console.warn('[FaceStroke] 四网络清单不可用', err);
        return null;
      });
  }
  return manifestPromise;
}

/** 加载四个推理会话。四个模型共用同一份 ORT 运行库。 */
export function loadEnsembleSessions() {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const manifest = await loadEnsembleManifest();
      if (!manifest) return null;
      // ORT 的 wasm 路径由 cnn.js 统一准备（自管 blob + 显式 MIME 类型）
      try { await prepareWasmPaths(); } catch { /* 交给 create 报错 */ }
      const sessions = [];
      for (const entry of manifest.files) {
        // 顺序加载：四个模型同时解压 wasm 会在低端机上抢内存
        // eslint-disable-next-line no-await-in-loop
        const session = await ort.InferenceSession.create(`${baseDir()}${entry.file}`, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        sessions.push({ backbone: entry.backbone, session });
      }
      return { manifest, sessions };
    })().catch((err) => {
      console.warn('[FaceStroke] 四网络加载失败', err);
      return null;
    });
  }
  return sessionsPromise;
}

export function isEnsembleLoaded() {
  return !!sessionsPromise;
}

/**
 * 人脸对齐裁剪：按双眼连线转正，再以双眼中点为中心裁成正方形。
 * **与 train/stroke_ensemble.py 的 align_face 必须保持一致。**
 *
 * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap} src
 * @param {Array<{x:number,y:number}>} landmarks 归一化关键点
 * @returns {HTMLCanvasElement|null}
 */
export function alignFace(src, landmarks) {
  if (!landmarks || landmarks.length < 264) return null;
  const w = src.width || src.videoWidth || 0;
  const h = src.height || src.videoHeight || 0;
  if (!w || !h) return null;
  const le = [landmarks[LEFT_EYE].x * w, landmarks[LEFT_EYE].y * h];
  const re = [landmarks[RIGHT_EYE].x * w, landmarks[RIGHT_EYE].y * h];
  const mid = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2];
  const dx = re[0] - le[0];
  const dy = re[1] - le[1];
  const eyeDist = Math.hypot(dx, dy) || 1;
  const side = eyeDist * MARGIN;
  const scale = INPUT / side;
  const theta = Math.atan2(dy, dx);

  const canvas = document.createElement('canvas');
  canvas.width = INPUT;
  canvas.height = INPUT;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(INPUT / 2, INPUT / 2);
  // 逆时针转 theta，使双眼连线水平（与 PIL 的 rotate(angle) 方向一致）
  ctx.rotate(-theta);
  ctx.scale(scale, scale);
  ctx.drawImage(src, -mid[0], -mid[1]);
  ctx.restore();
  return canvas;
}

/** 与训练端一致的归一化张量。 */
function toTensor(canvas) {
  const small = document.createElement('canvas');
  small.width = INPUT;
  small.height = INPUT;
  const c = small.getContext('2d', { willReadFrequently: true });
  c.drawImage(canvas, 0, 0, INPUT, INPUT);
  const { data } = c.getImageData(0, 0, INPUT, INPUT);
  const plane = INPUT * INPUT;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const o = i * 4;
    out[i] = (data[o] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (data[o + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (data[o + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', out, [1, 3, INPUT, INPUT]);
}

function sigmoid(v) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))));
}

/**
 * 跑一次四网络集成。
 * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap} src
 * @param {Array<{x:number,y:number}>} landmarks
 * @returns {Promise<{probability:number, perBackbone:Array<{backbone:string,p:number}>,
 *                    profile:string, trained:boolean}|null>}
 *          null 表示不可用（模型缺失或推理失败），调用方必须如实说明
 */
export async function predictStrokeEnsemble(src, landmarks) {
  const loaded = await loadEnsembleSessions();
  if (!loaded) return null;
  const canvas = alignFace(src, landmarks);
  if (!canvas) return null;
  try {
    const tensor = toTensor(canvas);
    const per = [];
    for (const { backbone, session } of loaded.sessions) {
      // eslint-disable-next-line no-await-in-loop
      const out = await session.run({ input: tensor });
      const key = Object.keys(out)[0];
      const logit = Number(out[key].data[0]);
      per.push({ backbone, p: sigmoid(logit) });
    }
    const probability = per.reduce((s, x) => s + x.p, 0) / per.length;
    return {
      probability,
      perBackbone: per,
      profile: loaded.manifest.profile,
      trained: loaded.manifest.trained === true,
    };
  } catch (err) {
    console.warn('[FaceStroke] 四网络推理失败', err);
    return null;
  }
}

/** 模型自报的骨干清单，供「评估原理」页展示。 */
export async function ensembleBackbones() {
  const m = await loadEnsembleManifest();
  return m ? m.backbones : [];
}
