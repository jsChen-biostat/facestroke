/**
 * S12 · 免责声明（完整版）
 * Spec: 09 合规与伦理文件包 第四节 / 02 §7
 *
 * Reached from the footer link on every screen. Previously that link did nothing.
 */

export default {
  id: 'disclaimer',
  route: '#/disclaimer',
  title: '免责声明',

  render(root) {
    root.innerHTML = `
      <h1 class="screen-title">免责声明</h1>

      <div class="card">
        <ol class="legal">
          <li>本应用为健康自检辅助工具，<b>不是医疗器械</b>，不提供医学诊断。</li>
          <li>检测结果<b>仅供参考</b>，可能存在漏判或误判，不能作为就医、用药或其他医疗决定的依据。</li>
          <li>本应用<b>不能替代医生面诊</b>，也<b>不能替代急救服务</b>。</li>
          <li><b>如出现口角歪斜、言语不清、一侧肢体无力、突发剧烈头痛、视力障碍等症状，请立即就医或拨打 120。</b></li>
          <li>面部不对称也可能由面神经炎、低血糖、癫痫发作后状态、偏头痛、牙科或眼部疾病等引起。</li>
          <li>拍摄时的光线、角度、表情、遮挡与设备差异均可能影响结果。</li>
          <li>本应用不适用于未满 14 周岁的儿童。</li>
          <li>所有面部图像仅在本机处理，<b>不会上传</b>，不会用于身份识别。</li>
        </ol>
      </div>

      <div class="card">
        <b>使用建议</b>
        <p>本应用适合关注脑血管健康的人群用于日常自我观察。它给出的是趋势参考，而非诊断结论。
        如对自身健康有疑问，请咨询医生。</p>
      </div>

      <button class="btn-secondary" data-back>返回</button>`;
  },
};
