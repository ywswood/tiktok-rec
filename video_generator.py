import os
import sys
import re
import json
import base64
import requests
import subprocess
import random
from typing import Dict, List, Optional

# ==========================================
# 1. Configuration
# ==========================================
ROOT_DIR = "C:\\data\\dev\\tiktok-rec"
BIN_DIR = "C:\\data\\dev\\bin"
FFMPEG_PATH = os.path.join(BIN_DIR, "ffmpeg.exe")
TEMP_DIR = os.path.join(ROOT_DIR, "data", "temp")
os.makedirs(TEMP_DIR, exist_ok=True)
BGM_DIR = os.path.join(ROOT_DIR, "bgm")

# API Bank Info
BANK_URL = "https://script.google.com/macros/s/AKfycbxCscLkbbvTUU7sqpZSayJ8pEQlWl8mrEBaSy_FklbidJRc649HwWc4SF0Q3GvUQZbuGA/exec"
BANK_PASS = "1030013"
PROJECT_NAME = "tiktok-rec"

# Font Settings
FONT_MAIN = "C:/Windows/Fonts/arial.ttf"
FONT_SUB = "C:/Windows/Fonts/msgothic.ttc"

# ==========================================
# 2. TTS Backend (Gemini Multimodal TTS via API Bank)
# ==========================================
def get_tts_audio(text: str, output_path: str) -> bool:
    """API Bank からキーを取得し、Gemini API で音声を生成する"""
    try:
        # 1. API Bank からキーとモデル名を取得 (type=tts -> config_vシートを参照)
        params = {"pass": BANK_PASS, "project": PROJECT_NAME, "type": "tts"}
        res = requests.get(BANK_URL, params=params, timeout=30)
        bank_data = res.json()
        
        if bank_data.get("status") != "success":
            print(f"Bank Error: {bank_data.get('message')}")
            return False
        
        api_key = bank_data["api_key"]
        model_name = bank_data["model_name"]
        
        # 2. Gemini API 呼び出し (Multimodal Generation)
        api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        payload = {
            "contents": [{
                "parts": [{ "text": text }]
            }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": "Puck" # TikTokで人気の高い男性ボイス
                        }
                    }
                }
            }
        }
        
        response = requests.post(api_url, json=payload, timeout=60)
        res_json = response.json()
        
        # 3. レスポンスから音声バイナリを抽出
        if "candidates" in res_json:
            # REST API は一般的に camelCase (inlineData) を返す
            parts = res_json["candidates"][0]["content"]["parts"][0]
            audio_data_base64 = parts.get("inlineData", {}).get("data")
            if audio_data_base64:
                import wave
                raw_audio = base64.b64decode(audio_data_base64)
                with wave.open(output_path, "wb") as wf:
                    wf.setnchannels(1)      # モノラル
                    wf.setsampwidth(2)     # 16-bit
                    wf.setframerate(24000) # 24kHz (Gemini TTS default)
                    wf.writeframes(raw_audio)
                return True
        
        print(f"Gemini API Error: {res_json}")
        return False
        
    except Exception as e:
        print(f"TTS Exception: {e}")
        return False

# ==========================================
# 3. BGM Selector
# ==========================================
def get_random_bgm(bgm_type: str) -> Optional[str]:
    """
    指定されたジャンルのBGMをassets/bgmからランダムに取得
    フォルダ構造: assets/bgm/{type}/xxx.mp3
    """
    type_dir = os.path.join(BGM_DIR, bgm_type.lower())
    if not os.path.exists(type_dir):
        # ジャンルフォルダがない場合はルートから探すか、デフォルトを返す
        type_dir = BGM_DIR
    
    files = [f for f in os.listdir(type_dir) if f.endswith(('.mp3', '.wav'))]
    if not files:
        return None
    return os.path.join(type_dir, random.choice(files))

# ==========================================
# 4. Video Rendering (FFmpeg Typography + BGM Mix)
# ==========================================
# ==========================================
# 4. Video Rendering (Rich Typography + BGM Mix)
# ==========================================
def parse_gradient(grad_str: str) -> List[str]:
    """linear-gradient(...) から hex カラーを抽出"""
    return re.findall(r'#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})', grad_str)

def render_typography_video(plan: Dict, tts_path: str, output_file: str):
    import re
    scenes = plan.get("scenes", [])
    design = plan.get("design", {})
    theme = design.get("theme", {})
    bgm_type = plan.get("bgm", "chill")
    
    # 1. Background Design
    grad_str = theme.get("background", "linear-gradient(to bottom, #1a1a2e, #16213e)")
    colors = parse_gradient(grad_str)
    if not colors:
        colors = ["1a1a2e", "16213e"]
    
    c1 = colors[0] if len(colors) > 0 else "1a1a2e"
    c2 = colors[1] if len(colors) > 1 else "16213e"
    
    # hex 3桁を6桁に変換
    if len(c1) == 3: c1 = "".join([c*2 for c in c1])
    if len(c2) == 3: c2 = "".join([c*2 for c in c2])
    
    text_color = theme.get("textColor", "white")
    if text_color.startswith('0x'):
        text_color = "#" + text_color[2:]
    
    accent_color = theme.get("accentColor", "#ff0080")
    if accent_color.startswith('0x'):
        accent_color = "#" + accent_color[2:]

    # フォントパスのエスケープ (Windows: C\: 形式が安定)
    f_main = FONT_MAIN.replace(":", "\\:")
    f_sub = FONT_SUB.replace(":", "\\:")
    
    bgm_path = get_random_bgm(bgm_type)
    total_duration = sum([s.get("duration", 2) for s in scenes])
    filter_complex = []

    # --- 安定版背景 (単色) ---
    # 0xRRGGBB が不安定な可能性があるため、一旦シンプルな色でテスト。
    # 本来は c1 を使いたいが、確実に動かすために 'darkblue' 等を検討
    filter_complex.append(f"color=c=0x{c1}:s=720x1280:d={total_duration + 1}[bg_base]")
    
    last_v_label = "[bg_base]"
    current_time = 0
    
    anim_type = design.get("animation", "pop")
    
    for i, scene in enumerate(scenes):
        duration = float(scene.get("duration", 2))
        text_en = (scene.get("text_en") or scene.get("text", "")).replace("'", "\\'").replace(":", "\\:")
        text_ja = (scene.get("text_ja") or "").replace("'", "\\'").replace(":", "\\:")
        
        start = current_time
        end = start + duration
        
        # 位置計算
        base_x = "(w-text_w)/2"
        base_y = "(h-text_h)/2"
        
        if anim_type == "slide":
            base_x = f"((w-text_w)/2)+1000*(1-min(1,(t-{start})/0.2))"
        elif anim_type == "pop":
            base_y = f"((h-text_h)/2)-100*sin(min(1,(t-{start})/0.3)*PI)"
        elif anim_type == "zoom":
            base_y = f"((h-text_h)/2)-150*(1-min(1,(t-{start})/0.25))"

        # fontcolor はシンプルな white 等をデフォルトに
        t_color = theme.get('textColor', 'white').replace('#', '0x')
        if not t_color.startswith('0x') and not t_color.isalpha():
            t_color = 'white'

        drawtext_main = (
            f"drawtext=fontfile='{f_main}':text='{text_en}':fontcolor={t_color}:fontsize=90:"
            f"box=1:boxcolor=black@0.4:boxborderw=15:"
            f"x={base_x}:y={base_y}"
        )
        
        v_next = f"[v{i}a]"
        filter_complex.append(f"{last_v_label}{drawtext_main}:enable='between(t,{start},{end})'{v_next}")
        
        v_final = f"[v{i}]"
        if text_ja:
            filter_complex.append(
                f"{v_next}drawtext=fontfile='{f_sub}':text='{text_ja}':fontcolor={t_color}:fontsize=40:"
                f"box=1:boxcolor=black@0.4:boxborderw=8:"
                f"x=(w-text_w)/2:y=h-300:enable='between(t,{start},{end})'{v_final}"
            )
        else:
            filter_complex.append(f"{v_next}null{v_final}")
            
        last_v_label = v_final
        current_time += duration

    # 2. Audio Mix
    audio_mix = []
    inputs = ["-i", tts_path]
    if bgm_path and os.path.exists(bgm_path):
        # BGMをループ入力として追加
        inputs += ["-stream_loop", "-1", "-i", bgm_path]
        audio_mix = [
            f"[1:a]volume=0.1[bgm_v]",
            f"[0:a][bgm_v]amix=inputs=2:duration=first:dropout_transition=1[out_a]"
        ]
        map_a = "[out_a]"
    else:
        map_a = "0:a"

    filter_script_path = os.path.join(TEMP_DIR, f"{os.path.basename(output_file)}_filter.txt")
    with open(filter_script_path, "w", encoding="utf-8") as f:
        f.write(";".join(filter_complex + audio_mix))
    
    cmd = [
        FFMPEG_PATH, "-y"
    ] + inputs + [
        "-filter_complex_script", filter_script_path,
        "-map", last_v_label, "-map", map_a,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", 
        "-preset", "veryfast", "-t", str(total_duration),
        output_file
    ]
    
    print(f"Executing FFmpeg... Total Duration: {total_duration}s")
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8")
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg Error Output:\n{e.stderr}")
        raise
    finally:
        if os.path.exists(filter_script_path):
            os.remove(filter_script_path)

if __name__ == "__main__":
    test_plan = {
        "scenes": [
            {"text_en": "Consistency is key.", "text_ja": "継続が力なり", "duration": 3},
            {"text_en": "Start today.", "text_ja": "今日から始めよう", "duration": 3}
        ],
        "design": {"theme": {"textColor": "white"}},
        "bgm": "chill"
    }
    # Usage: python video_generator.py test_plan.json tts.wav output.mp4
    print("Video Generator Ready.")
