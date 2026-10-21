/**
 * 面部不对称检测模型（初版 v0.1）—— 纯 JS 推理
 *
 * 任务：判断本次图像是否呈现**明显的面部左右不对称**。
 * **不是**中风判别，**不是**诊断。模型的输出只有一句话的含义：
 * 「这张脸左右不对称的程度是否明显」。
 *
 * 为什么是几何特征而不是像素
 *   用像素训练时，纯颜色特征就能以 AUC 0.999 区分训练集的两组 ——
 *   那学的是"图片来自哪个文件夹"（格式/锐度/饱和度），与病理无关。
 *   改用关键点几何特征后该捷径被压到 0.778，模型的 AUC 是 0.818。
 *
 * 为什么权重是 JSON 而不是 ONNX
 *   权重只有 45 KB，纯 JS 几次矩阵乘法即可，**不需要 14 MB 的 ONNX Runtime**；
 *   安装包不变大、启动不变慢，而且权重可被人工检查。
 *
 * ⚠️ 必须随结果一起告知用户的局限
 *   1. 标签是**代理标签**：训练集的两组文件夹被当作"有/无面部神经肌肉异常"，
 *      而该数据集已知混入面神经炎与来源不明的人像，标签可靠性有限；
 *   2. 训练底图存在"拍摄条件与类别共线"的问题，几何特征只是削弱、没有完全消除；
 *   3. 样本量小（约 800 张），未做外部验证；
 *   4. **模型不区分病因**，不能作为诊断依据。
 */

const MODEL_URL = new URL('models/asymmetry_model.json', document.baseURI).href;

let modelPromise = null;

/** 懒加载权重；失败不抛异常，返回 null 由调用方决定怎么显示。 */
export function loadAsymmetryModel() {
  if (!modelPromise) {
    modelPromise = fetch(MODEL_URL, { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`asymmetry model HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        console.warn('[FaceStroke] 不对称模型加载失败', err);
        return null;
      });
  }
  return modelPromise;
}

export function isModelLoaded() {
  return !!modelPromise;
}

/** numpy 的线性插值百分位，必须与训练端一致。 */
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(a) {
  if (!a.length) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / a.length); // 与 numpy 默认 ddof=0 一致
}

const L_EYE_OUT = 33;
const R_EYE_OUT = 263;
const NASION = 168;
const CHIN = 152;

/**
 * 把一张脸搬进标准坐标系：原点=双眼中点，尺度=眼距，旋转=中线垂直。
 * 这样分辨率、画幅、清晰度都不再直接进入特征。
 * @param {Array<{x:number,y:number,z:number}>} lm 478 个归一化关键点
 * @returns {Array<[number,number]>} 标准坐标系下的 478 个二维点
 */
function canonicalFrame(lm) {
  const e1 = lm[L_EYE_OUT];
  const e2 = lm[R_EYE_OUT];
  const mid = [(e1.x + e2.x) / 2, (e1.y + e2.y) / 2];
  let sx = e2.x - e1.x;
  let sy = e2.y - e1.y;
  const scale = Math.hypot(sx, sy) || 1e-9;
  let ux = lm[NASION].x - lm[CHIN].x;
  let uy = lm[NASION].y - lm[CHIN].y;
  const un = Math.hypot(ux, uy) || 1e-9;
  ux /= un;
  uy /= un;
  // e = [[uy, -ux], [ux, uy]]，与训练端同一构造
  const out = new Array(lm.length);
  for (let i = 0; i < lm.length; i += 1) {
    const x = (lm[i].x - mid[0]) / scale;
    const y = (lm[i].y - mid[1]) / scale;
    out[i] = [x * uy + y * ux, x * -ux + y * uy];
  }
  return out;
}

/**
 * 计算与训练端完全一致的 70 维特征。
 * @param {Array<{x:number,y:number,z:number}>} lm
 * @param {object} model asymmetry_model.json
 */
export function buildFeatures(lm, model) {
  const C = canonicalFrame(lm);
  const { pairs, pair_bin: bins, features } = model;
  const nBins = features.n_bins;

  const errs = new Array(pairs.length);
  for (let k = 0; k < pairs.length; k += 1) {
    const [i, j] = pairs[k];
    const dx = -C[i][0] - C[j][0];
    const dy = C[i][1] - C[j][1];
    errs[k] = Math.hypot(dx, dy);
  }

  const byBin = Array.from({ length: nBins }, () => []);
  for (let k = 0; k < errs.length; k += 1) byBin[bins[k]].push(errs[k]);

  const f = [];
  for (let b = 0; b < nBins; b += 1) {
    const arr = byBin[b].slice().sort((p, q) => p - q);
    f.push(arr.length ? mean(arr) : 0.0);
    f.push(arr.length ? percentile(arr, 0.9) : 0.0);
  }
  const sorted = errs.slice().sort((p, q) => p - q);
  f.push(mean(errs));
  f.push(percentile(sorted, 0.5));
  f.push(std(errs));
  f.push(percentile(sorted, 0.75));
  f.push(percentile(sorted, 0.9));
  f.push(sorted[sorted.length - 1]);
  return f;
}

/** 前向传播：70 → tanh(24) → sigmoid(1) */
function forward(model, f) {
  const { mu, sd } = model.norm;
  const { W1, b1, W2, b2, hidden } = model.mlp;
  const a1 = new Array(hidden);
  for (let h = 0; h < hidden; h += 1) {
    let z = b1[h];
    for (let k = 0; k < f.length; k += 1) {
      z += ((f[k] - mu[k]) / sd[k]) * W1[k][h];
    }
    a1[h] = Math.tanh(z);
  }
  let z2 = b2[0];
  for (let h = 0; h < hidden; h += 1) z2 += a1[h] * W2[h];
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z2))));
}

/**
 * 预测「明显面部不对称」的可能性。
 * @param {Array<{x:number,y:number,z:number}>} landmarks 恰好 478 个
 * @returns {Promise<{probability:number, percent:number, model:string}|null>}
 *          返回 null 表示模型不可用；调用方必须如实说明，不得当作"没测到面部"
 */
export async function predictAsymmetry(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;
  const model = await loadAsymmetryModel();
  if (!model) return null;
  try {
    const f = buildFeatures(landmarks, model);
    const p = forward(model, f);
    return { probability: p, percent: Math.round(p * 1000) / 10, model: model.name };
  } catch (err) {
    console.warn('[FaceStroke] 不对称模型推理失败', err);
    return null;
  }
}

/** 供结果页显示的一句话解释；不要在其他地方另写一份。 */
export const ASYMMETRY_MODEL_NOTE =
  '本模型只判断「左右不对称是否明显」，不区分病因，不能作为诊断依据。'
  + '它的训练数据有限，且训练图像存在拍摄条件与类别共线的问题，尚未做外部验证。';

/** 模型自报的实测指标（来自训练报告的测试集）。 */
export const ASYMMETRY_MODEL_METRICS = { auc: 0.818, accuracy: 0.733, n: 794 };
