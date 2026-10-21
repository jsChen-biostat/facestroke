/**
 * S8 · 评估原理说明
 * Spec: 03 功能规格 S8 / 06 §3.8
 * 2026-10-02: formal register (user feedback).
 */

import { guide } from '../core/tts.js';

export default {
  id: 'algorithm',
  route: '#/algorithm',
  title: '评估原理',

  render(root) {
    root.innerHTML = `
      <h1 class="screen-title">评估原理</h1>

      <div class="card">
        <span class="q-title">评估流程</span>
        <ol class="legal">
          <li>在面部定位 <b>478 个关键点</b>。</li>
          <li>将面部一侧镜像至另一侧，测量两侧的<b>镜像误差</b>。</li>
          <li>按临床观察区域分区统计：<b>额纹区、眼睑区、鼻唇沟区、口角区</b>。</li>
          <li>与同期参与评估的 AI 模型结果进行交叉校验。</li>
        </ol>
      </div>

      <div class="card">
        <span class="q-title">第二通道 · 面部不对称检测</span>
        <p class="small">除了几何测量，本应用还有第二个方法再判断一次「左右是否对称」。
        它看的是<b>面部关键点之间的几何关系</b>，不看图片的颜色、格式或清晰度 ——
        因为后几项与身体状况无关，拿它们训练会学错东西。</p>
        <p class="small">这个通道<b>不改变分数</b>，只做一致性核对：两个方法结论一致时更可信；
        不一致时会如实提示，建议在相同光线下重测一次。</p>
        <p class="small">它目前是初版，训练数据有限，<b>不区分病因，不能作为诊断依据</b>。</p>
      </div>

      <div class="card">
        <span class="q-title">分数含义</span>
        <p>分数区间为 0–100，<b>100 表示左右完全对称</b>。</p>
        <p>该分数反映的是「本次采集到的面部形态与人群参考分布的相对位置」，
        <b>不代表是否患有疾病</b>。</p>
      </div>

      <div class="card">
        <span class="q-title">为什么不能作为诊断依据</span>
        <ul class="legal">
          <li>拍摄的光线、角度、表情与遮挡均会影响测量结果；</li>
          <li>面神经炎、低血糖、癫痫发作后状态、偏头痛、牙科或眼部疾病等亦可造成面部不对称；</li>
          <li>本工具的参考分布来自公开数据集，尚未进行大规模真实人群验证。</li>
        </ul>
      </div>

      <button class="btn-secondary" data-back>返回</button>`;
    guide('评估原理说明。在面部定位四百七十八个关键点，将面部一侧镜像至另一侧，测量镜像误差，'
      + '并按额纹、眼睑、鼻唇沟、口角四个区域分别统计。分数区间为零到一百分，一百分表示完全对称。'
      + '该分数不代表是否患有疾病，不能作为诊断依据。');
  },
};
