# fftts.py （TTSナレーション生成 + 動画組み立て + BGM全体ミックス統合版 + Google Drive連携）
# 最新修正:
# - sessionId をコマンドラインから受け取り
# - スプレッドシート（F列：日本語、G列：英語）からテキストを取得
# - Google Driveから各ファイルを取得・保存

import os
import sys
import subprocess
import asyncio
import edge_tts
import whisper
import re
import json
import tempfile
import shutil
from pathlib import Path
from PIL import Image
from dotenv import load_dotenv

# Google API
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload
import io

# ================================================
# 環境設定
# ================================================
load_dotenv()

# Google API スコープ
SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
]

FFMPEG_PATH = r"C:\data\dev\.313p\bin\ffmpeg.exe"

# GCP認証ファイル
GCP_CREDS_FILE = os.getenv("GCP_CREDS_FILE", "./gcp_creds.json")
TOKEN_FILE = "token.json"

# Google API設定
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")

# Google Drive フォルダID
VOICE_FOLDER_ID = os.getenv("VOICE_FOLDER_ID")
PICTURE_FOLDER_ID = os.getenv("PICTURE_FOLDER_ID")
BGM_FOLDER_ID = os.getenv("BGM_FOLDER_ID")
VIDEO_FOLDER_ID = os.getenv("VIDEO_FOLDER_ID")
TTS_FOLDER_ID = os.getenv("TTS_FOLDER_ID")

# ローカル一時作業ディレクトリ
WORK_DIR = None  # セッション開始時に作成

# フォント・レイアウト設定
FONT_PART = "fontfile='C\:/Windows/Fonts/yumin.ttf'"
BASE_VF = "zoompan=z='zoom+0.001':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1080x1920:fps=30"

ENGLISH_COEF = 10
JP_COEF = 50
LINE_SPACING = 110
JP_LINE_SPACING = 40

MAX_CHARS_PER_LINE = 20
MAX_CHARS_PER_LINE_JP = 40

MIN_INTERVAL = 3
MAX_INTERVAL = 5

BGM_VOLUME = "0.1"
OVERLAY_OPACITY = "0.85"

# TTS設定
TTS_VOICE = "en-US-ChristopherNeural"
TTS_RATE = "+35%"
TTS_VOLUME = "+10%"
TTS_PITCH = "+20Hz"

# 黒背景メッセージ設定
USE_FINAL_BLACK_MESSAGE = True
FINAL_MESSAGE = "Japan is the last bastion."
FINAL_MESSAGE_DURATION = 0.5

# ================================================
# Google API認証
# ================================================
def get_google_credentials():
    """Google APIの認証情報を取得"""
    creds = None
    
    # token.json が存在する場合、保存されたトークンを使う
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    # トークンが無効か存在しない場合、認証フローを実行
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # トークン更新
            creds.refresh(Request())
        else:
            # 初回認証フロー（ブラウザで認証）
            flow = InstalledAppFlow.from_client_secrets_file(
                GCP_CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=8080)
        
        # token.json に保存
        with open(TOKEN_FILE, 'w') as token:
            token.write(creds.to_json())
    
    return creds

def get_sheets_service():
    """Google Sheets APIサービスを取得"""
    creds = get_google_credentials()
    return build('sheets', 'v4', credentials=creds)

def get_drive_service():
    """Google Drive APIサービスを取得"""
    creds = get_google_credentials()
    return build('drive', 'v3', credentials=creds)

# ================================================
# スプレッドシート操作
# ================================================
def scan_unprocessed_rows():
    """
    スプレッドシートから未処理の行を検出
    条件：F列（日本語）≠空 かつ I列（動画ファイルID）= 空
    戻り値：[(session_id, row_num), ...] のリスト
    """
    try:
        service = get_sheets_service()
        result = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID,
            range='txt!A:I'  # txt シートの A列～I列を取得
        ).execute()
        
        rows = result.get('values', [])
        if not rows:
            print("スプレッドシートが空です")
            return []
        
        unprocessed = []
        for row_idx, row in enumerate(rows[1:], start=2):  # ヘッダーをスキップ
            # A列（Index 0）= session_id
            # F列（Index 5）= 日本語テキスト
            # I列（Index 8）= 動画ファイルID
            
            session_id = row[0] if len(row) > 0 else ""
            japanese_text = row[5] if len(row) > 5 else ""
            video_file_id = row[8] if len(row) > 8 else ""
            
            # 条件：F列≠空 かつ I列=空
            if japanese_text.strip() and not video_file_id.strip():
                unprocessed.append((session_id, row_idx))
        
        print(f"📋 未処理の行を検出：{len(unprocessed)}件")
        for session_id, row_num in unprocessed:
            print(f"  Row {row_num}: {session_id}")
        
        return unprocessed
    
    except Exception as e:
        print(f"❌ スプレッドシート スキャンエラー: {e}")
        return []

def get_text_from_sheet(session_id):
    """
    スプレッドシートからsession_idに対応する行を取得
    F列：日本語テキスト、G列：英語テキスト、K列：BGMジャンル
    """
    try:
        service = get_sheets_service()
        result = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID,
            range='txt!A:K'  # txt シート の A列～K列を取得
        ).execute()
        
        rows = result.get('values', [])
        if not rows:
            raise ValueError("スプレッドシートが空です")
        
        # session_id を A列で検索（最新の行を優先）
        target_row = None
        for i in range(len(rows) - 1, 0, -1):
            if len(rows[i]) > 0 and str(rows[i][0]) == session_id:
                target_row = rows[i]
                break
        
        if not target_row:
            raise ValueError(f"Session ID '{session_id}' がスプレッドシートに見つかりません")
        
        # F列（Index 5）= 日本語、G列（Index 6）= 英語、K列（Index 10）= BGMジャンル
        japanese_text = target_row[5] if len(target_row) > 5 else ""
        english_text = target_row[6] if len(target_row) > 6 else ""
        bgm_genre = target_row[10].lower() if len(target_row) > 10 and target_row[10] else "chill"
        
        if not japanese_text or not english_text:
            raise ValueError(f"テキストが不足しています。日本語: {bool(japanese_text)}, 英語: {bool(english_text)}")
        
        print(f"✅ スプレッドシートから取得成功 (Session: {session_id})")
        print(f"📝 日本語: {japanese_text[:50]}...")
        print(f"📝 英語: {english_text[:50]}...")
        print(f"🎵 BGMジャンル: {bgm_genre}")
        
        return japanese_text, english_text, bgm_genre
    
    except Exception as e:
        print(f"❌ スプレッドシート取得エラー: {e}")
        sys.exit(1)


def update_sheet_video_id(session_id, video_id):
    """スプレッドシートの I列（videoFileId）を更新"""
    try:
        service = get_sheets_service()
        
        # session_id の行番号を特定
        result = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID,
            range='txt!A:A'  # session_id を探すため A列をスキャン
        ).execute()
        
        values = result.get('values', [])
        row_num = None
        
        for idx, row in enumerate(values):
            if len(row) > 0 and str(row[0]) == session_id:
                row_num = idx + 1  # 1-based インデックス
                break
        
        if not row_num:
            print(f"❌ Session ID '{session_id}' がスプレッドシートに見つかりません")
            return False
        
        # I列 (9列目) を更新
        cell_range = f'txt!I{row_num}'
        update_range_data = {
            'values': [[video_id]]
        }
        
        service.spreadsheets().values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=cell_range,
            valueInputOption='USER_ENTERED',
            body=update_range_data
        ).execute()
        
        print(f"✅ スプレッドシート I列を更新: Row {row_num} = {video_id}")
        return True
    
    except Exception as e:
        print(f"❌ スプレッドシート更新エラー: {e}")
        return False

# ================================================
# Google Drive ダウンロード・アップロード
# ================================================
def download_file_from_drive(file_id, output_path):
    """Google Drive からファイルをダウンロード"""
    try:
        service = get_drive_service()
        request = service.files().get_media(fileId=file_id)
        
        with open(output_path, 'wb') as f:
            downloader = MediaIoBaseDownload(f, request)
            done = False
            while not done:
                status, done = downloader.next_chunk()
        
        print(f"✅ ダウンロード成功: {output_path}")
        return output_path
    
    except Exception as e:
        print(f"❌ ダウンロードエラー: {e}")
        return None

def download_bgm_by_genre(bgm_genre):
    """BGMジャンルに応じてサブフォルダからランダムにBGMを取得"""
    try:
        service = get_drive_service()
        import random
        
        # BGM フォルダ直下のサブフォルダを検索（chill または energy）
        query = f"'{BGM_FOLDER_ID}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'"
        results = service.files().list(q=query, spaces='drive', fields='files(id, name)', pageSize=10).execute()
        folders = results.get('files', [])
        
        target_folder_id = None
        for folder in folders:
            if folder['name'].lower() == bgm_genre.lower():
                target_folder_id = folder['id']
                break
        
        if not target_folder_id:
            print(f"⚠️ BGMジャンル '{bgm_genre}' のフォルダが見つかりません。親フォルダから探します")
            target_folder_id = BGM_FOLDER_ID
        
        # ジャンルフォルダ内のファイルをすべて取得
        query = f"'{target_folder_id}' in parents and trashed=false and mimeType='audio/mpeg'"
        results = service.files().list(q=query, spaces='drive', fields='files(id, name)', pageSize=100).execute()
        files = results.get('files', [])
        
        if not files:
            print(f"⚠️ BGMフォルダにファイルが見つかりません")
            return None
        
        # ランダムに1つ選択
        selected_file = random.choice(files)
        file_id = selected_file['id']
        file_name = selected_file['name']
        output_path = os.path.join(WORK_DIR, file_name)
        
        print(f"🎵 BGM選択: {file_name}")
        return download_file_from_drive(file_id, output_path)
    
    except Exception as e:
        print(f"❌ BGMダウンロードエラー: {e}")
        return None

def download_all_files_from_folder(folder_id, output_dir, num_select=None):
    """フォルダ内の全ファイルをダウンロード、オプションでランダム選出"""
    try:
        service = get_drive_service()
        import random
        
        query = f"'{folder_id}' in parents and trashed=false"
        results = service.files().list(q=query, spaces='drive', fields='files(id, name)', pageSize=100).execute()
        files = results.get('files', [])
        
        if not files:
            print(f"⚠️ フォルダにファイルが見つかりません: {folder_id}")
            return []
        
        downloaded_files = []
        for file in files:
            file_id = file['id']
            file_name = file['name']
            output_path = os.path.join(output_dir, file_name)
            
            if download_file_from_drive(file_id, output_path):
                downloaded_files.append(output_path)
        
        print(f"✅ {len(downloaded_files)} 個のファイルをダウンロード")
        
        # ランダム選出が指定されている場合
        if num_select and num_select > 0 and len(downloaded_files) > num_select:
            downloaded_files = random.sample(downloaded_files, num_select)
            print(f"🎲 ランダムに {len(downloaded_files)} 個を選出")
        
        return downloaded_files
    
    except Exception as e:
        print(f"❌ フォルダダウンロードエラー: {e}")
        return []

def upload_file_to_drive(file_path, folder_id, session_id):
    """ファイルを Google Drive にアップロード (YYMMDD_連番 形式)"""
    try:
        service = get_drive_service()
        
        # session_id から YYMMDD を抽出
        date_match = re.match(r'^(\d{2,4})(\d{2})(\d{2})', session_id)
        if date_match:
            # YYMMDD 形式に統一
            yymmdd = date_match.group(1)[-2:] + date_match.group(2) + date_match.group(3)
        else:
            yymmdd = '000000'
        
        # video フォルダ内で YYMMDD_*.mp4 の最大連番を探す
        query = f"'{folder_id}' in parents and trashed=false and name contains '{yymmdd}_'"
        results = service.files().list(q=query, spaces='drive', fields='files(name)', pageSize=100).execute()
        existing_files = results.get('files', [])
        
        max_num = 0
        for existing_file in existing_files:
            match = re.search(r'_([0-9]+)\.mp4$', existing_file['name'])
            if match:
                num = int(match.group(1))
                if num > max_num:
                    max_num = num
        
        next_num = str(max_num + 1).zfill(2)
        file_name = f"{yymmdd}_{next_num}.mp4"
        
        file_metadata = {
            'name': file_name,
            'parents': [folder_id]
        }
        
        media = MediaFileUpload(file_path, mimetype='video/mp4')
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id'
        ).execute()
        
        print(f"✅ アップロード成功: {file_name} (ID: {file['id']})")
        return file['id']
    
    except Exception as e:
        print(f"❌ アップロードエラー: {e}")
        return None

# ================================================
# TTSナレーション生成
# ================================================
async def generate_narration(english_text):
    """edge_tts を使ってナレーション生成"""
    narration_path = os.path.join(WORK_DIR, "narration_edge.mp3")
    
    print(f"🎤 TTS生成開始: {english_text[:50]}...")
    
    communicate = edge_tts.Communicate(
        english_text,
        voice=TTS_VOICE,
        rate=TTS_RATE,
        volume=TTS_VOLUME,
        pitch=TTS_PITCH
    )
    
    await communicate.save(narration_path)
    print(f"✅ TTS生成完了: {narration_path}")
    return narration_path

# ================================================
# 画像をTikTok縦型に変換
# ================================================
def convert_to_tiktok_vertical(input_path, target_size=(1080, 1920)):
    """画像をTikTok縦型に変換（上書き）"""
    if not os.path.isfile(input_path):
        return None
    
    img = Image.open(input_path).convert('RGB')
    orig_w, orig_h = img.size
    target_w, target_h = target_size
    target_ratio = target_w / target_h
    orig_ratio = orig_w / orig_h

    if orig_ratio > target_ratio:
        new_w = target_w
        new_h = int(target_w / orig_ratio)
    else:
        new_h = target_h
        new_w = int(target_h * orig_ratio)

    resized = img.resize((new_w, new_h), Image.LANCZOS)
    background = Image.new('RGB', target_size, (0, 0, 0))
    background.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2))
    background.save(input_path, quality=95)
    return input_path

# ================================================
# テキスト分割
# ================================================
def split_text_to_lines(text, max_chars):
    """テキストをライン分割"""
    if re.search(r'[\u3040-\u30FF\u4E00-\u9FFF]', text):
        lines = []
        current_line = ""
        for char in text:
            if len(current_line) < max_chars:
                current_line += char
            else:
                lines.append(current_line)
                current_line = char
        if current_line:
            lines.append(current_line)
        return lines
    else:
        words = text.split(' ')
        lines = []
        current_line = ""
        for word in words:
            test_line = f"{current_line} {word}" if current_line else word
            if len(test_line) <= max_chars:
                current_line = test_line
            else:
                if current_line:
                    lines.append(current_line)
                current_line = word
        if current_line:
            lines.append(current_line)
        return lines

# ================================================
# Whisper タイムスタンプ取得
# ================================================
def get_timestamps_from_whisper(mp3_path):
    """Whisperでタイムスタンプ取得"""
    if not os.path.isfile(mp3_path):
        print(f"🔴 mp3が見つかりません: {mp3_path}")
        sys.exit(1)

    model = whisper.load_model("base.en")
    result = model.transcribe(mp3_path, word_timestamps=True)

    timestamps = []
    current_start = 0.0
    current_text = ""

    for segment in result["segments"]:
        seg_start = segment["start"]
        seg_end = segment["end"]
        seg_text = segment["text"].strip()

        if seg_end - current_start >= MIN_INTERVAL and (seg_end - current_start <= MAX_INTERVAL or current_text):
            timestamps.append({
                "start": current_start,
                "end": seg_end,
                "text": (current_text + " " + seg_text).strip()
            })
            current_start = seg_end
            current_text = ""
        else:
            current_text += " " + seg_text if current_text else seg_text

    if current_text:
        timestamps.append({
            "start": current_start,
            "end": result["segments"][-1]["end"] if result["segments"] else 0,
            "text": current_text.strip()
        })

    print("\n📊 生成されたタイムスタンプ:")
    for ts in timestamps:
        print(f"  {ts['start']:.1f}s - {ts['end']:.1f}s : {ts['text']}")

    return timestamps

# ================================================
# 動画作成（2段階処理）
# ================================================
def create_video(timestamps, images, japanese_text, bgm_path, narration_path):
    """動画を作成"""
    segment_files_final = []

    jp_sentences = re.split(r"(?<=。|！|？)", japanese_text)
    jp_sentences = [s.strip() for s in jp_sentences if s.strip()]

    seg_count = len(timestamps)
    total_sentences = len(jp_sentences)
    group_size = (total_sentences + seg_count - 1) // seg_count

    jp_groups = []
    start = 0
    for i in range(seg_count):
        end = min(start + group_size, total_sentences)
        group = jp_sentences[start:end]
        jp_groups.append("".join(group))
        start = end

    print("\n🎬 日本語グループ割り当て:")
    for idx, group in enumerate(jp_groups, 1):
        print(f"  グループ {idx}: {group}")

    for i, ts in enumerate(timestamps):
        img_path = images[i % len(images)]
        seg_duration = ts["end"] - ts["start"]

        # ── ステップ1：英語字幕だけをセンターに配置 ──
        english_lines = split_text_to_lines(ts["text"], MAX_CHARS_PER_LINE)
        line_count_eng = len(english_lines)

        eng_block_height = (line_count_eng - 1) * LINE_SPACING
        eng_center_y = 960
        eng_start_y = eng_center_y - eng_block_height // 2

        draw_eng = []
        for j, line in enumerate(english_lines):
            line_text = line.replace("'", "''")
            y = eng_start_y + j * LINE_SPACING
            draw_eng.append(
                f"drawtext=text='{line_text}':fontcolor=white:fontsize=w/{ENGLISH_COEF}:borderw=4:bordercolor=black@0.6:"
                f"x=(w-tw)/2:y={y}:{FONT_PART}"
            )

        vf_eng = BASE_VF
        if draw_eng:
            vf_eng += "," + ",".join(draw_eng)

        english_clip = os.path.join(WORK_DIR, f"english_{i:02d}.mp4")

        cmd_eng = [
            FFMPEG_PATH,
            "-loop", "1",
            "-i", img_path,
            "-t", str(seg_duration),
            "-vf", vf_eng,
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "ultrafast",
            "-crf", "23",
            english_clip,
            "-y"
        ]

        print(f"📹 セグメント {i+1}/{len(timestamps)} 英語クリップ生成中...")
        subprocess.run(cmd_eng, check=True)

        # ── ステップ2：英語クリップに日本語字幕＋全体グレー網掛け ──
        jp_this = jp_groups[i] if i < len(jp_groups) else ""
        jp_lines = split_text_to_lines(jp_this, MAX_CHARS_PER_LINE_JP)
        line_count_jp = len(jp_lines)

        jp_bottom = 1920 - 100
        jp_start_y = jp_bottom - (line_count_jp - 1) * JP_LINE_SPACING

        draw_jp = []
        for j, line in enumerate(jp_lines):
            line_text = line.replace("'", "''")
            y = jp_start_y + j * JP_LINE_SPACING
            draw_jp.append(
                f"drawtext=text='{line_text}':fontcolor=white:fontsize=w/{JP_COEF}:borderw=3:bordercolor=black@0.6:"
                f"x=(w-tw)/2:y={y}:{FONT_PART}"
            )

        # 全体に薄いグレー網掛けを追加
        overlay_filter = f"color=c=gray@0.35:s=1080x1920[gray];[0:v][gray]overlay=0:0:enable='between(t,0,{seg_duration})',eq=brightness=-0.08:contrast=1.05"

        vf_jp = overlay_filter
        if draw_jp:
            vf_jp += "," + ",".join(draw_jp)

        final_seg = os.path.join(WORK_DIR, f"segment_{i:02d}.mp4")

        cmd_jp = [
            FFMPEG_PATH,
            "-i", english_clip,
            "-vf", vf_jp,
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "ultrafast",
            "-crf", "23",
            "-t", str(seg_duration),
            final_seg,
            "-y"
        ]

        print(f"🎬 セグメント {i+1}/{len(timestamps)} に日本語＋グレー網掛けを追加中...")
        subprocess.run(cmd_jp, check=True)

        segment_files_final.append(final_seg)

    # ── 最終結合 ──
    concat_list_path = os.path.join(WORK_DIR, "concat.txt")
    with open(concat_list_path, "w", encoding="utf-8") as f:
        for seg in segment_files_final:
            f.write(f"file '{seg}'\n")

    final_output = os.path.join(WORK_DIR, "final_tiktok_video.mp4")

    if USE_FINAL_BLACK_MESSAGE:
        black_clip = os.path.join(WORK_DIR, "black_05sec.mp4")
        cmd_black = [
            FFMPEG_PATH,
            "-f", "lavfi",
            "-i", f"color=c=black:s=1080x1920:d={FINAL_MESSAGE_DURATION}",
            "-vf", "fps=30,format=yuv420p",
            black_clip,
            "-y"
        ]
        subprocess.run(cmd_black, check=True)

        final_message_vf = (
            f"drawtext=text='{FINAL_MESSAGE}':fontcolor=white:fontsize=100:borderw=6:bordercolor=black:"
            f"box=0:x=(w-tw)/2:y=(h-th)/2:enable='between(t,0,{FINAL_MESSAGE_DURATION})':{FONT_PART}"
        )

        black_with_text = os.path.join(WORK_DIR, "black_with_text.mp4")
        cmd_text = [
            FFMPEG_PATH,
            "-i", black_clip,
            "-vf", final_message_vf,
            "-t", str(FINAL_MESSAGE_DURATION),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            black_with_text,
            "-y"
        ]
        subprocess.run(cmd_text, check=True)

        with open(concat_list_path, "a", encoding="utf-8") as f:
            f.write(f"file '{black_with_text}'\n")

    cmd_concat = [
        FFMPEG_PATH,
        "-f", "concat",
        "-safe", "0",
        "-i", concat_list_path,
        "-i", narration_path,
        "-i", bgm_path,
        "-filter_complex",
        "[1:a]volume=1.0[nar];"
        f"[2:a]volume={BGM_VOLUME}[bgm];"
        "[nar][bgm]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        final_output,
        "-y"
    ]

    print("\n🎞️ 全セグメントを結合中...")
    result = subprocess.run(cmd_concat, capture_output=True, text=True)

    print(f"FFmpeg 戻り値: {result.returncode}")
    if result.returncode != 0:
        print("=== エラー詳細 ===")
        print(result.stderr)
        print("================")
        sys.exit(1)

    print(f"\n✅ 動画生成完了: {final_output}")
    return final_output

# ================================================
# メイン処理
# ================================================
async def main_async(session_id):
    """メイン処理"""
    global WORK_DIR
    
    # 作業ディレクトリ作成
    WORK_DIR = tempfile.mkdtemp(prefix=f"tiktok_rec_{session_id}_")
    print(f"\n📁 作業ディレクトリ: {WORK_DIR}")
    
    try:
        # 1. スプレッドシートからテキスト取得
        print("\n=== ステップ1: テキスト取得 ===")
        japanese_text, english_text, bgm_genre = get_text_from_sheet(session_id)
        
        # 2. Google Drive からファイルダウンロード
        print("\n=== ステップ2: ファイルダウンロード ===")
        
        # BGM を取得（ジャンルに応じて）
        print(f"🎵 BGM をダウンロード中... (ジャンル: {bgm_genre})")
        bgm_path = download_bgm_by_genre(bgm_genre)
        if not bgm_path:
            raise ValueError("BGMファイルが見つかりません")
        
        # 画像を取得
        print("🖼️ 画像をダウンロード中...")
        image_paths = download_all_files_from_folder(PICTURE_FOLDER_ID, WORK_DIR)
        if not image_paths:
            raise ValueError("画像ファイルが見つかりません")
        
        # 画像をTikTok縦型に変換
        for img_path in image_paths:
            convert_to_tiktok_vertical(img_path)
        
        # 3. TTS生成
        print("\n=== ステップ3: TTS生成 ===")
        narration_path = await generate_narration(english_text)
        
        # 4. Whisper でタイムスタンプ取得
        print("\n=== ステップ4: タイムスタンプ取得 ===")
        timestamps = get_timestamps_from_whisper(narration_path)
        
        # 5. 動画生成
        print("\n=== ステップ5: 動画生成 ===")
        video_path = create_video(timestamps, image_paths, japanese_text, bgm_path, narration_path)
        
        # 6. Google Drive にアップロード
        print("\n=== ステップ6: Google Drive にアップロード ===")
        video_id = upload_file_to_drive(video_path, VIDEO_FOLDER_ID, session_id)
        
        # 7. スプレッドシートの I列（videoFileId）を更新
        if video_id:
            print(f"\n=== ステップ7: スプレッドシート更新 ===")
            update_sheet_video_id(session_id, video_id)
        
        print("\n✅ 全処理完了！")
    
    finally:
        # 作業ディレクトリ削除
        if WORK_DIR and os.path.exists(WORK_DIR):
            shutil.rmtree(WORK_DIR)
            print(f"\n🗑️ 作業ディレクトリを削除しました")

# ================================================
# エントリーポイント
# ================================================
if __name__ == "__main__":
    if len(sys.argv) < 2:
        # 引数なし = 自動スキャンモード
        print("🔄 自動スキャンモード: スプレッドシートから未処理の行を検出中...")
        unprocessed = scan_unprocessed_rows()
        
        if not unprocessed:
            print("✅ 処理する行がありません")
            sys.exit(0)
        
        # 最初の未処理行を処理
        session_id, row_num = unprocessed[0]
        print(f"\n🎬 処理開始 (Row {row_num}): {session_id}")
        asyncio.run(main_async(session_id))
    else:
        # 引数あり = 指定された session_id を処理
        session_id = sys.argv[1]
        print(f"\n🎬 TikTok Rec 動画生成開始 (Session: {session_id})")
        asyncio.run(main_async(session_id))
