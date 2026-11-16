// D299：发音组件的朗读——系统 TTS（Web Speech：Windows / macOS 自带语音，离线、零网络、零新依赖；
// 与词典朗读 dictClient.speakText 同一能力）。按词条语言挑本机语音；没有对应语音时仍朗读（系统缺省语音），
// 并把结果标为「近似」——组件同时显示音标与近似读音，所以没有 TTS 语音时也可用。
export type SpeakResult = "exact" | "approx" | "none";

/** 无 lang 时按文字猜语言（只分得清文字系统；拉丁字母一律按英语） */
export function guessLang(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[Ͱ-Ͽ]/.test(text)) return "el";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

/** 在本机语音里找 lang：精确（sv-SE）→ 同语种（sv-*）。纯函数，便于单测 */
export function pickVoice<V extends { lang: string }>(voices: readonly V[], lang: string): V | null {
  const want = lang.toLowerCase().replace("_", "-");
  const base = want.split("-")[0];
  return voices.find((v) => v.lang.toLowerCase().replace("_", "-") === want) ?? voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base) ?? null;
}

export function speakForeign(text: string, lang?: string): SpeakResult {
  try {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return "none";
    synth.cancel();
    const want = lang || guessLang(text);
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(synth.getVoices(), want);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = want;
    }
    u.rate = 0.85; // 学读音：略慢于正常语速
    synth.speak(u);
    return voice ? "exact" : "approx";
  } catch {
    return "none";
  }
}
