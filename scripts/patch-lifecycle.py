#!/usr/bin/env python3
"""在保留 1.5.6 温度算法补丁之后，修复 1.5.7 的驱动启动生命周期。"""
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
def replace(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit('N5 lifecycle anchor mismatch: ' + old[:60])
    s = s.replace(old, new, 1)

start = s.index("const driverload = require('./driverload');")
end = s.index('/* boot reconcile:', start)
s = s[:start] + """const driverload = require('./driverload');
let n5Driver = { status: 'checking' };
let n5Lifecycle = null;

""" + s[end:]
replace('function reconcileOnBoot() {', 'function reconcileOnBoot(n5Ready = false) {')
replace('''function reconcileOnBoot(n5Ready = false) {
  try {
    for (const fan of buildFans(scanHwmon())) {
      if (!fan.pwm) continue;
''', '''function reconcileOnBoot(n5Ready = false) {
  try {
    for (const fan of buildFans(scanHwmon())) {
      if (fan.chip === 'minisforum_n5_it5571' && !n5Ready) continue;
      if (!fan.pwm) continue;
''')
replace('reconcileOnBoot();\n', """reconcileOnBoot();
n5Lifecycle = require('./n5-startup').start({
  loader: driverload, dmi: dmiInfo, log: appendLog,
  onState: state => { n5Driver = state; }, reconcile: state => { n5Driver = state; reconcileOnBoot(true); }
});
""")
replace("process.on('SIGTERM', () => {\n", """process.on('SIGTERM', () => {
  if (n5Lifecycle) n5Lifecycle.stop();
""")
replace("""  for (const fan of buildFans(chips)) {
    const cur = getCurve(fan.key);
""", """  for (const fan of buildFans(chips)) {
    if (fan.chip === 'minisforum_n5_it5571' && !['loaded', 'already-loaded'].includes(n5Driver.status)) continue;
    const cur = getCurve(fan.key);
""")
replace('function setPwm(chipName, index, value, auto) {\n', """function setPwm(chipName, index, value, auto) {
  if (chipName === 'minisforum_n5_it5571' && !['loaded', 'already-loaded'].includes(n5Driver.status)) {
    const err = new Error('N5 驱动尚未通过加载检查');
    err.code = 409;
    throw err;
  }
""")
# 最终写入入口兜住告警/检测/恢复路径，未验证模块不接受任何 N5 PWM 写入。
replace("""function writeFile(p, v) {
  fs.writeFileSync(p, String(v));
}
""", """function writeFile(p, v) {
  if (/[/]pwm[0-9]/.test(p) && readFile(path.join(path.dirname(p), 'name')) === 'minisforum_n5_it5571' &&
      !['loaded', 'already-loaded'].includes(n5Driver.status)) {
    throw new Error('N5 PWM 写入被阻止：驱动尚未通过加载检查');
  }
  fs.writeFileSync(p, String(v));
}
""")
p.write_text(s)
