import whisper
import os
import json
import re
import sys
import subprocess

# Add FFmpeg to PATH for whisper
os.environ["PATH"] += os.pathsep + "C:\\data\\dev\\.313p\\.venv\\Scripts"

def analyze_audio_and_split_scenes(audio_path: str, full_text_en: str, full_text_ja: str) -> tuple:
    """
    Whisperを使用して音声を解析し、3〜5秒ごとのシーン構成（タイムスタンプ付き）を生成する。
    戻り値: (scenes, normalized_audio_path)
    """
    print(f"Analyzing audio: {audio_path}")
    
    # 0. 音声の正規化 (Gemini TTSの出力が Raw PCM の場合があるため)
    normalized_path = audio_path + ".normalized.wav"
    ffmpeg_exe = "C:\\data\\dev\\.313p\\.venv\\Scripts\\ffmpeg.exe"
    try:
        # まずは通常通り試行
        cmd = [ffmpeg_exe, "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", normalized_path]
        res = subprocess.run(cmd, capture_output=True)
        
        if res.returncode != 0:
            # 失敗した場合、Gemini TTS標準の Raw PCM (s16le, 24kHz, mono) としてリトライ
            print(f"  Warning: Standard FFMPEG load failed. Retrying as Raw PCM (24kHz)...")
            cmd = [ffmpeg_exe, "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", audio_path, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", normalized_path]
            subprocess.run(cmd, check=True, capture_output=True)
        
        audio_to_analyze = normalized_path
    except Exception as e:
        print(f"Error: Audio normalization (including PCM fallback) failed: {e}")
        audio_to_analyze = audio_path # Final fallback

    # 1. Whisperモデルのロード (速度優先でbaseを使用)
    model = whisper.load_model("base")
    
    # 2. 文字起こし（タイムスタンプ取得）
    result = model.transcribe(audio_to_analyze, verbose=False, word_timestamps=True, initial_prompt=full_text_en)
    
    segments = result.get("segments", [])
    if not segments:
        return [], audio_to_analyze

    # 3. 単語レベルのデータをフラット化
    all_words = []
    for seg in segments:
        for word_data in seg.get("words", []):
            all_words.append(word_data)

    # 4. 3〜5秒程度の区切りでシーンを構築
    scenes = []
    current_scene_words = []
    current_start = -1
    
    for i, w in enumerate(all_words):
        if current_start == -1:
            current_start = w["start"]
        
        current_scene_words.append(w["word"].strip())
        current_end = w["end"]
        duration = current_end - current_start
        
        # 次の単語を含めると5秒を超えるか、あるいは文末（句読点）で区切りが良い場合
        is_last = (i == len(all_words) - 1)
        next_duration = (all_words[i+1]["end"] - current_start) if not is_last else 0
        
        # 3秒以上かつ (5秒超える前 or 文末っぽい or 最後)
        if (duration >= 3.0 and (next_duration > 5.0 or re.search(r'[.!?]$', w["word"]) or is_last)) or is_last:
            scene_text_en = " ".join(current_scene_words).replace('\n', ' ').strip()
            
            # 日本語訳は、英語の進行度に合わせて元の full_text_ja から推測（簡易的に文字数比で按分）
            # 本来的にはAIで再翻訳するか、句読点を合わせるのが理想
            scenes.append({
                "text_en": scene_text_en,
                "text_ja": "", # 後ほど埋める
                "start": current_start,
                "end": current_end,
                "duration": round(duration, 2)
            })
            current_scene_words = []
            current_start = -1

    # 5. 日本語テキストの割り当て (英英比率ベースで推定)
    # TODO: より正確なマッピングが必要な場合は Gemini に依頼することを検討
    total_en_chars = len(full_text_en)
    total_ja_chars = len(full_text_ja)
    
    if total_en_chars > 0 and total_ja_chars > 0:
        ja_ptr = 0
        for i, scene in enumerate(scenes):
            en_len = len(scene["text_en"])
            ja_len_est = int((en_len / total_en_chars) * total_ja_chars)
            # 最後のシーンは残りを全部入れる
            if i == len(scenes) - 1:
                scene["text_ja"] = full_text_ja[ja_ptr:].strip()
            else:
                # 句読点で区切るように少し調整
                segment_ja = full_text_ja[ja_ptr:ja_ptr + ja_len_est + 5]
                last_punct = re.search(r'[、。！？！？\s]', segment_ja[::-1])
                if last_punct:
                    cut_idx = len(segment_ja) - last_punct.start()
                    scene["text_ja"] = full_text_ja[ja_ptr:ja_ptr + cut_idx].strip()
                    ja_ptr += cut_idx
                else:
                    scene["text_ja"] = full_text_ja[ja_ptr:ja_ptr + ja_len_est].strip()
                    ja_ptr += ja_len_est

    return scenes, audio_to_analyze

if __name__ == "__main__":
    # Test code
    test_audio = "test.wav"
    if os.path.exists(test_audio):
        res = analyze_audio_and_split_scenes(test_audio, "This is a test text.", "これはテストテキストです。")
        print(json.dumps(res, indent=2, ensure_ascii=False))
