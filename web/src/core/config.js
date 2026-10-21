/**
 * Single source of truth for every number that needs a human decision.
 * See 04_technical_architecture.md section 8.
 *
 * RULES
 *  - `null` means "not yet approved by a human". A screen that needs a null
 *    value must NOT produce a result; it should say the result is unavailable.
 *  - Changing any value here requires an entry in 10_进度状态_接力板.md.
 *  - Never hard-code a threshold anywhere else in the app.
 */

export const CONFIG = {
  appVersion: 'v1.0-prototype',

  // Model / copy fingerprints shown in the settings screen (traceability).
  fingerprints: {
    geo: 'geo-v1.0',
    cnn: 'cnn-v1.0', // M-Q + M-S exported by train/train_models.py
    fusion: 'fusion-1.0',
    copy: null, // set after the doctor signs off the wording (task T-11)
  },

  // Tier boundaries on the 0-100 symmetry score.
  //
  // 🔴-01 STATUS: NOT APPROVED BY A DOCTOR.
  // These are PROVISIONAL, machine-derived development values so the flow can be
  // exercised end to end. They come from the non-stroke calibration distribution
  // (work/reports/symmetry_calibration.md): a score of 70 corresponds to
  // A ~= 0.095, which sits near the population p85; 50 -> A ~= 0.122; 30 -> A ~= 0.149.
  //
  // While `approved` is false the result screen MUST show a visible
  // "provisional thresholds" warning and the tier must never be presented as a
  // medical conclusion.
  thresholds: {
    aMin: 70, // A 未见异常: score >= 70
    bMin: 50, // B 建议关注: 50 <= score < 70
    cMin: 30, // C 建议就医: 30 <= score < 50 ; below 30 => D 紧急
    approved: false,
    source: 'calibration-percentile-derived (provisional)',
    ambiguousBand: 3, // scores within +/- this of a boundary are "unclear"
  },

  // 🔴-02 channel weights and CNN role. NOT approved.
  //
  // 05b §5 defines a downgrade rule: if M-S is clearly worse than the geometric
  // channel, it becomes a CROSS-CHECK (it may flag disagreement but may not move
  // the score). The trained M-S reached test MAE 19.3 points / Spearman 0.52 and
  // is worst exactly where it matters (MAE 32.8 in the 0-20 score bin), so the
  // rule fires and the geometric channel carries the score.
  weights: {
    geo: 1.0,
    cnn: 0.0,
    role: 'cross-check', // 'scored' | 'cross-check'
    approved: false,
    source: 'M-S test MAE 19.3 / Spearman 0.52 -> downgraded per 05b §5',
  },

  // 🔴 absolute difference between the two channels that counts as a conflict
  fusionConflictGap: 25,

  // Capture quality gates (task T-09; thresholds CALIBRATED in T-17).
  //
  // These were placeholders until the T-17 regression set existed. The control
  // group exposed that three of them were wrong (see
  // web/scripts/calibrate_quality.mjs and 08_测试与内测方案 §2):
  //   sharpness 45 was ABOVE the clean-frame minimum (27.3) -> 5 of 8 good
  //     frames were rejected as blurry
  //   maxBrightnessMean 225 sat inside the blown-out range (177-248)
  //   minFaceWidthRatio 0.28 sat INSIDE the too-far range (0.217-0.325)
  // Values below are placed between the clean and degraded distributions.
  // They still need re-tuning against REAL phone captures in T-20.
  quality: {
    minBrightnessMean: 55,   // dark max 37.2 | clean min 95.6
    maxBrightnessMean: 174,  // clean max 171.3 | blown-out min 177.4
    // Yaw gate in inter-ocular units. The bad set only makes this testable when
    // the control faces are themselves near-frontal, which is what the guidance
    // ring asks of the user (train/build_badset.py filters for that).
    // Calibration independently suggests 0.151.
    maxYawProxy: 0.15,
    maxYawDeg: 15,
    minFaceWidthRatio: 0.40, // too-far max 0.325 | clean min 0.483 (suggested 0.404)
    minSharpness: 15,        // blurred max 0.9 | dark max 4.9 | clean min 27.3
    // Occlusion heuristic: lower-face focus relative to the eye band. A mask or
    // a hand flattens the mouth region (measured: 0.0 covered vs 0.891+ clean).
    minMouthFlatness: 0.45,
    framesToCapture: 10,
    framesToKeep: 3,
    countdownSeconds: 3,
    // M-Q veto: only a high-confidence hard-bad prediction blocks a capture. The
    // trained M-Q has ok-recall 0.75, so a low bar here would reject good frames.
    cnnRejectConfidence: 0.85,
    maxFrameSpread: null,    // 🔴 spread above which capture counts as unstable
  },


  /**
   * 四网络集成通道（与文献 Aging Cell 2024;23:e14196 相同的框架）。
   * 文献用 Xception + ResNet50 + VGG19 + EfficientNetB1 对**二维人脸图像**做识别。
   * 那四个骨干合计 763 MB（VGG19 一个就 558 MB），装不进手机安装包，
   * 因此默认用 light 档：MobileNetV3-Large + ResNet18 + EfficientNet-B0 + SqueezeNet。
   * **集成方式、输入尺寸、人脸对齐、训练脚本都与文献一致，只有骨干可替换。**
   * 模型由 train/stroke_ensemble.py 导出到 web/public/models/ensemble/。
   *
   * 当前是**未训练**的占位权重（ensemble.json 里 trained: false）。
   * 界面读到该标志必须如实标注：输出数字仅为流程演示，不代表任何真实风险。
   */
  strokeEnsemble: {
    enabled: true,
    dir: 'models/ensemble',
  },
  // Gate questionnaire (task T-08/T-09). Pure policy, no tuning needed.
  gate: {
    riskAgeBands: ['45-59', '60-74', '75+'],
    minAge: 14,
  },

  // Detection-pacing rule: the analysis stage shows REAL steps with REAL
  // intermediate artifacts, and must not fake its duration (03 功能规格 S6).
  // `stepReadMs` is a READING dwell time so an older user can actually see each
  // artifact; it is not presented to the user as computation time. The real
  // computation time per step is measured and shown separately.
  pacing: {
    analysisMinMs: 8000,
    analysisMaxMs: 12000,
    stepReadMs: 1600,
  },
};

/**
 * Collect every un-approved (null) value.
 * Screens call this to decide whether they may produce a result.
 * @returns {string[]} dotted paths of missing values
 */
export function missingConfig() {
  const missing = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v === null) missing.push(path);
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
    }
  };
  walk(CONFIG, '');
  return missing;
}

/** True when a given dotted path is still un-approved. */
export function isMissing(path) {
  return missingConfig().includes(path);
}
