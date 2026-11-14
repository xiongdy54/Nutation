// pdf.js ES2025 兼容层（v28）：pdf.js v6 用的新 API 起于 Electron 31/Chromium 126 缺失，逐项补齐。
// 主线程版（adapter.ts 内联）与 worker 版（测试插件前置 + 下方 WORKER_POLYFILL 字符串）必须同构；
// **不可删**（GUIDE §8.1 D198 实测）：Electron 42.11.15 = Chromium 148 渲染进程里
// Map.prototype.getOrInsertComputed **仍缺失**，D198 明记「该兼容层不可删」；当前 electron 45.0.0。
// 原生补齐后 if 守卫自动失效，无需改代码——但删文件/删调用前必须先实测三项 API 全部可用。
// 清单（2026-09-12 实测扫描 pdfjs-dist 6.3.289 全量源码）：
//   Map.getOrInsertComputed（主线程+worker）/ Promise.try（worker，支持剩余参数透传）/
//   Uint8Array.toHex（worker，PDF 指纹用）/ Array.findLast（主线程原生已有，无需补）
const PDF_COMPAT_POLYFILL = `
if (typeof Promise !== "undefined" && typeof Promise.try !== "function") {
  Promise.try = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) { resolve(fn.apply(null, args)); });
  };
}
if (typeof Map !== "undefined" && typeof Map.prototype.getOrInsertComputed !== "function") {
  Map.prototype.getOrInsertComputed = function (key, fn) {
    if (this.has(key)) return this.get(key);
    var v = fn(key);
    this.set(key, v);
    return v;
  };
}
if (typeof Uint8Array !== "undefined" && typeof Uint8Array.prototype.toHex !== "function") {
  Uint8Array.prototype.toHex = function () {
    var out = "";
    for (var i = 0; i < this.length; i++) {
      var h = this[i].toString(16);
      out += h.length < 2 ? "0" + h : h;
    }
    return out;
  };
}
`;
module.exports = { PDF_COMPAT_POLYFILL };
