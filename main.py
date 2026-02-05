"""
TikTok Rec - 動画自動生成メインスクリプト
スプシをポーリングし、未処理の行を検出して動画を生成する
"""
import os
import re
import json
import time
import requests
from dotenv import load_dotenv
from video_generator import get_tts_audio, render_typography_video, get_random_bgm

# ==========================================
# 1. Configuration
# ==========================================
load_dotenv()

CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
REFRESH_TOKEN = os.getenv("GOOGLE_REFRESH_TOKEN")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
VIDEO_FOLDER_ID = os.getenv("DRIVE_FOLDER_ID")

SHEET_NAME = "txt"
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR = os.path.join(ROOT_DIR, "data", "temp")
os.makedirs(TEMP_DIR, exist_ok=True)

# ==========================================
# 2. OAuth2 Token Management
# ==========================================
def get_access_token() -> str:
    url = "https://oauth2.googleapis.com/token"
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": REFRESH_TOKEN,
        "grant_type": "refresh_token"
    }
    res = requests.post(url, data=data, timeout=30)
    token_data = res.json()
    if "access_token" in token_data:
        return token_data["access_token"]
    raise Exception(f"Token refresh failed: {token_data}")

# ==========================================
# 3. Google Sheets API
# ==========================================
def get_pending_rows(token: str) -> list:
    """動画ファイルIDが空の行を取得（カラムI = index 8）"""
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{SHEET_NAME}!A:L"
    headers = {"Authorization": f"Bearer {token}"}
    print(f"DEBUG: Fetching from {SHEET_NAME}...")
    res = requests.get(url, headers=headers, timeout=30)
    print(f"DEBUG: Sheets Fetch Status: {res.status_code}")
    data = res.json()
    rows = data.get("values", [])
    
    if not rows:
        print(f"DEBUG: No data found in sheet '{SHEET_NAME}'")
        return []

    pending = []
    for i, row in enumerate(rows[1:], start=2):  # Skip header, 1-indexed for Sheets API
        # カラムK (index 10) までデータがあるか確認
        if len(row) > 10:
            bgm = row[8] if len(row) > 8 else "chill"          # カラムI (index 8)
            video_file_id = row[9] if len(row) > 9 else ""     # カラムJ (index 9)
            text_file_id = row[10] if len(row) > 10 else ""    # カラムK (index 10)
            
            if not video_file_id and text_file_id:
                pending.append({
                    "row_num": i,
                    "id": row[0],
                    "caption_ja": row[5] if len(row) > 5 else "",
                    "caption_en": row[6] if len(row) > 6 else "",
                    "hashtags": row[7] if len(row) > 7 else "",
                    "bgm": bgm,
                    "text_file_id": text_file_id
                })
    return pending

def update_video_file_id(token: str, row_num: int, video_file_id: str):
    """スプシの動画ファイルIDを更新（カラムJ = index 9）"""
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{SHEET_NAME}!J{row_num}?valueInputOption=RAW"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {"values": [[video_file_id]]}
    print(f"DEBUG: Updating Sheet Row {row_num} (Column J) with {video_file_id}...")
    res = requests.put(url, headers=headers, json=body, timeout=30)
    print(f"DEBUG: Update Response ({res.status_code}): {res.text}")
    return res.status_code == 200

# ==========================================
# 4. Google Drive API
# ==========================================
def download_text_file(token: str, file_id: str) -> str:
    """DriveからテキストファイルをダウンロードしてプランJSONを抽出"""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get(url, headers=headers, timeout=60)
    if res.status_code == 200:
        res.encoding = 'utf-8'
        return res.text
    return ""

def extract_plan_from_text(text: str) -> dict:
    """テキストファイルから【生成構成】以降のJSONを抽出"""
    match = re.search(r"【生成構成】\s*(\{[\s\S]+\})", text)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    return {}

def upload_video_to_drive(token: str, file_path: str, file_name: str) -> str:
    """動画をDriveにアップロードしてファイルIDを返す"""
    # 1. メタデータをPOST
    metadata = {
        "name": file_name,
        "parents": [VIDEO_FOLDER_ID]
    }
    
    # Resumable uploadを使用
    init_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    init_res = requests.post(init_url, headers=headers, json=metadata, timeout=30)
    
    if init_res.status_code != 200:
        print(f"Upload init failed: {init_res.text}")
        return ""
    
    upload_url = init_res.headers.get("Location")
    
    # 2. ファイルをアップロード
    with open(file_path, "rb") as f:
        file_data = f.read()
    
    upload_headers = {"Content-Type": "video/mp4"}
    upload_res = requests.put(upload_url, headers=upload_headers, data=file_data, timeout=300)
    
    if upload_res.status_code in [200, 201]:
        return upload_res.json().get("id", "")
    print(f"Upload failed: {upload_res.text}")
    return ""

# ==========================================
# 5. Main Processing Logic
# ==========================================
def process_single_row(token: str, row: dict) -> bool:
    """1行分の動画生成処理"""
    print(f"Processing: {row['id']}")
    
    # 1. テキストファイルからプランを取得
    text_content = download_text_file(token, row["text_file_id"])
    if not text_content:
        print(f"  Failed to download text file: {row['text_file_id']}")
        return False
    
    print(f"  Text file length: {len(text_content)}")
    print(f"  Text file preview: {text_content[:500]}")
    
    plan = extract_plan_from_text(text_content)
    if not plan:
        print(f"  Failed to extract plan from text file")
        print(f"  Looking for '【生成構成】' in text...")
        if "【生成構成】" in text_content:
            print(f"  Found marker, but JSON parse failed")
        else:
            print(f"  Marker not found in text")
        return False
    
    # 2. TTS音声を生成
    tts_path = os.path.join(TEMP_DIR, f"{row['id']}_tts.wav")
    # 新形式(text_en)と旧形式(text)の両方に対応
    tts_text = " ".join([s.get("text_en") or s.get("text", "") for s in plan.get("scenes", [])])
    print(f"  TTS text: {tts_text[:100]}...")
    
    if not get_tts_audio(tts_text, tts_path):
        print(f"  TTS generation failed")
        return False
    
    # 3. 動画を生成
    output_path = os.path.join(TEMP_DIR, f"{row['id']}.mp4")
    try:
        render_typography_video(plan, tts_path, output_path)
    except Exception as e:
        print(f"  Video rendering failed: {e}")
        return False
    
    if not os.path.exists(output_path):
        print(f"  Output video not found")
        return False
    
    # 4. Driveにアップロード
    video_file_id = upload_video_to_drive(token, output_path, f"{row['id']}.mp4")
    if not video_file_id:
        print(f"  Upload failed")
        return False
    
    # 5. スプシを更新
    if update_video_file_id(token, row["row_num"], video_file_id):
        print(f"  Done: {video_file_id}")
        return True
    
    print(f"  Spreadsheet update failed")
    return False

def run_once():
    """1回実行（未処理の全行を処理）"""
    print("=" * 50)
    print("TikTok Rec - Video Generator")
    print("=" * 50)
    
    token = get_access_token()
    pending = get_pending_rows(token)
    
    print(f"Pending rows: {len(pending)}")
    
    for row in pending:
        process_single_row(token, row)
        time.sleep(2)  # API負荷軽減

def run_loop(interval_sec: int = 60):
    """定期実行ループ"""
    while True:
        try:
            run_once()
        except Exception as e:
            print(f"Error: {e}")
        print(f"Next check in {interval_sec} seconds...")
        time.sleep(interval_sec)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--loop":
        run_loop()
    else:
        run_once()
