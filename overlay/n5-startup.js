'use strict';
// 仅负责异步加载生命周期；不计算温度、不改变曲线。
function start({ loader, dmi, log, onState, reconcile, delay = 300000,
  schedule = setTimeout, unschedule = clearTimeout }) {
  let stopped = false, timer = null;
  async function attempt() {
    if (stopped) return;
    let state;
    try {
      state = await loader.autoload(dmi(), log);
      if (stopped) return;
      state.bundled = loader.availableBuilds().map(b => b.kernel);
      if (state.status === 'loaded' || state.status === 'already-loaded') reconcile(state);
    } catch (e) {
      state = { status: 'failed', retryable: false, error: e.message };
    }
    if (stopped) return;
    onState(state);
    if (state.retryable) {
      // 完成后再调度，禁止网络慢时重叠重试。
      timer = schedule(attempt, delay);
      if (timer.unref) timer.unref();
    }
  }
  const initial = attempt();
  return { initial, stop() {
    stopped = true;
    if (timer !== null) unschedule(timer);
    loader.cancel();
  } };
}
module.exports = { start };
