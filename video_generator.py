import os
import sys
import re
import json
import base64
import requests
import subprocess
import random
import tempfile
from typing import Dict, List, Optional

# ==========================================
# 1. Configuration
# ==========================================
ROOT_DIR = "C:\\data\\dev\\tiktok-rec"
BIN_DIR = "C:\\data\\dev\\.313p\\.venv\\Scripts"
FFMPEG_PATH = os.path.join(BIN_DIR, "ffmpeg.exe")
TEMP_DIR = os.path.join(tempfile.gettempdir(), "tiktok-rec")
os.makedirs(TEMP_DIR, exist_ok=True)
# API Bank Info
BANK_URL = "https://script.google.com/macros/s/AKfycbxCscLkbbvTUU7sqpZSayJ8pEQlWl8mrEBaSy_FklbidJRc649HwWc4SF0Q3GvUQZbuGA/exec"
BANK_PASS = "1030013"
PROJECT_NAME = "tiktok-rec"

# Font Settings
FONT_DIR = "C:/Windows/Fonts"
FONT_MAP = {
    "impact": os.path.join(FONT_DIR, "impact.ttf").replace("\\", "/"),
    "mincho": os.path.join(FONT_DIR, "msmincho.ttc").replace("\\", "/"),
    "handwriting": os.path.join(FONT_DIR, "msgothic.ttc").replace("\\", "/"),
    "cyber": os.path.join(FONT_DIR, "consolas.ttf").replace("\\", "/"),
    "scatter": os.path.join(FONT_DIR, "ariblk.ttf").replace("\\", "/"),
    "default": os.path.join(FONT_DIR, "arial.ttf").replace("\\", "/")
}
FONT_MAIN = FONT_MAP["default"]
FONT_SUB = os.path.join(FONT_DIR, "msgothic.ttc").replace("\\", "/")

# ==========================================
# 4. Video Rendering (FFmpeg Typography + BGM Mix)
# ==========================================
# ==========================================
# 4. Video Rendering (Rich Typography + BGM Mix)
# ==========================================
def parse_gradient(grad_str: str) -> List[str]:
    """linear-gradient(...) から hex カラーを抽出"""
    return re.findall(r'#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})', grad_str)

def render_typography_video(plan: Dict, tts_path: str, output_file: str, bgm_path: str = None):
    import re
    scenes = plan.get("scenes", [])
    design = plan.get("design", {})
    if isinstance(design, str):
        design = {}
    theme = design.get("theme", {})
    if isinstance(theme, str):
        theme = {}
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

    # フォント決定
    font_key = design.get("font", "default").lower()
    # WindowsのFFmpegフィルタ内ではコロン ':' を '\:' にエスケープし、かつバックスラッシュをスラッシュに統一するのが安全
    f_main = FONT_MAP.get(font_key, FONT_MAIN).replace(":", "\\:").replace("\\", "/")
    f_sub = FONT_SUB.replace(":", "\\:").replace("\\", "/")
    
    scenes = plan.get("scenes", [])
    
    total_duration = sum([s.get("duration", 2) for s in scenes])
    filter_complex = []

    # 1.1 Background & Effects
    effect_type = design.get("effect", "simple")
    
    # 基本背景
    filter_complex.append(f"color=c=0x{c1}:s=720x1280:d={total_duration + 1}[bg_raw]")
    
    # 背景エフェクト
    last_bg_label = "[bg_raw]"
    if effect_type == "retro":
        filter_complex.append(f"{last_bg_label}noise=alls=10:allf=t,hue=s=0.5[bg_retro]")
        last_bg_label = "[bg_retro]"
    elif effect_type == "particle":
        # 簡易的なノイズで代用
        filter_complex.append(f"{last_bg_label}noise=cns=0.1[bg_part]")
        last_bg_label = "[bg_part]"

    last_v_label = last_bg_label
    current_time = 0
    
    anim_type = design.get("animation", "pop")
    
    for i, scene in enumerate(scenes):
        duration = float(scene.get("duration", 2))
        
        # 解析によって得られた詳細なタイムスタンプがあればそれを使用
        if "start" in scene and "end" in scene:
            start = float(scene["start"])
            end = float(scene["end"])
        else:
            start = current_time
            end = start + duration
        
        text_en = (scene.get("text_en") or scene.get("text", "")).replace('\n', ' ').replace("'", "\\'").replace(":", "\\:").strip()
        text_ja = (scene.get("text_ja") or "").replace('\n', ' ').replace("'", "\\'").replace(":", "\\:").strip()
        
        # 位置 & アニメーション定数
        base_x = "(w-text_w)/2"
        base_y = "(h-text_h)/2"
        alpha_expr = "1"
        
        if anim_type == "slide":
            base_x = f"((w-text_w)/2)+1000*(1-min(1,(t-{start})/0.2))"
        elif anim_type == "pop":
            base_y = f"((h-text_h)/2)-100*sin(min(1,(t-{start})/0.3)*PI)"
        elif anim_type == "zoom":
            base_y = f"((h-text_h)/2)-150*(1-min(1,(t-{start})/0.25))"
        elif anim_type == "fade":
            alpha_expr = f"min(1,(t-{start})/0.5)*min(1,({end}-t)/0.5)"
        elif anim_type == "typewriter":
            # 簡易版：フェードインで代用
            alpha_expr = f"min(1,(t-{start})/0.3)"

        # 文字色 & アクセント
        t_color = theme.get('textColor', 'white').replace('#', '0x')
        if not t_color.startswith('0x') and not t_color.isalpha():
            t_color = 'white'
            
        a_color = accent_color.replace('#', '0x')

        # エフェクト別の装飾
        extra_draw = ""
        if effect_type == "neon":
            # ネオン：光彩（シャドウを重ねる）
            extra_draw = f":shadowcolor={a_color}:shadowx=0:shadowy=0:box=1:boxcolor={a_color}@0.2"
        elif effect_type == "glitch":
            # グリッチ：ランダムな揺れ
            base_x = f"({base_x})+random(0)*10*between(t,{start},{end})"

        drawtext_main = (
            f"drawtext=fontfile='{f_main}':text='{text_en}':fontcolor={t_color}:fontsize=90:"
            f"box=1:boxcolor=black@0.4:boxborderw=15:"
            f"alpha='{alpha_expr}':x={base_x}:y={base_y}{extra_draw}"
        )
        
        v_next = f"[v{i}a]"
        filter_complex.append(f"{last_v_label}{drawtext_main}:enable='between(t,{start},{end})'{v_next}")
        
        v_final = f"[v{i}]"
        if text_ja:
            # 日本語字幕：アクセントカラーを背景ボックスに使用
            filter_complex.append(
                f"{v_next}drawtext=fontfile='{f_sub}':text='{text_ja}':fontcolor={t_color}:fontsize=40:"
                f"box=1:boxcolor={a_color}@0.6:boxborderw=8:"
                f"alpha='{alpha_expr}':x=(w-text_w)/2:y=h-300:enable='between(t,{start},{end})'{v_final}"
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
    print(f"Filter Script Path: {filter_script_path}")
    # print(f"Command: {' '.join(cmd)}") # Command might be too long
    
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8")
        print("FFmpeg Success.")
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg Failed with exit code {e.returncode}")
        print(f"FFmpeg Error Output:\n{e.stderr}")
        # フィルターの中身もエラー時には表示する（トラブルシューティング用）
        with open(filter_script_path, "r", encoding="utf-8") as f:
             print(f"Filter Script Content:\n{f.read()}")
        raise
    finally:
        # success時のみ削除
        pass 

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
